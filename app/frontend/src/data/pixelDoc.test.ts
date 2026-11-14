import { Timestamp } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PixelInfo } from '../types';

interface FakeSnap {
    exists(): boolean;
    data(): Record<string, unknown>;
    metadata: { fromCache: boolean };
}
interface Observer {
    next(snap: FakeSnap): void;
    error(e: { message: string; code: string }): void;
}

const sdk = vi.hoisted(() => ({ refs: [] as string[], observers: [] as Observer[], unsubscribed: 0 }));

vi.mock('./firebase', () => ({ getDb: () => ({}) }));
vi.mock('firebase/firestore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('firebase/firestore')>()),
    doc: (_db: unknown, ...path: string[]) => path.join('/'),
    onSnapshot: (ref: string, _options: unknown, observer: Observer) => {
        sdk.refs.push(ref);
        sdk.observers.push(observer);
        return () => {
            sdk.unsubscribed++;
        };
    },
}));

const { watchPixel } = await import('./pixelDoc');

const missing = (fromCache: boolean): FakeSnap => ({ exists: () => false, data: () => ({}), metadata: { fromCache } });
const present = (data: Record<string, unknown>, fromCache = false): FakeSnap => ({ exists: () => true, data: () => data, metadata: { fromCache } });

beforeEach(() => {
    sdk.refs.length = 0;
    sdk.observers.length = 0;
    sdk.unsubscribed = 0;
});

describe('watchPixel', () => {
    it('emits loading synchronously, then the document content', () => {
        const seen: PixelInfo[] = [];
        watchPixel(12, 34, (i) => seen.push(i));
        expect(seen).toEqual([{ status: 'loading' }]);
        expect(sdk.refs).toEqual(['pixels/12_34']);

        const data = { x: 12, y: 34, color: 5, user_id: '1234', updated_at: Timestamp.fromMillis(1_700_000_000_000) };
        sdk.observers[0].next(present(data, true));
        sdk.observers[0].next(present(data, false)); // metadata-only change: not repeated
        expect(seen).toEqual([{ status: 'loading' }, { status: 'ready', color: 5, userId: '1234', updatedAtMs: 1_700_000_000_000 }]);
    });

    it('reports empty only once the server confirms the document is missing', () => {
        const seen: PixelInfo[] = [];
        watchPixel(1, 1, (i) => seen.push(i));
        sdk.observers[0].next(missing(true));
        expect(seen).toEqual([{ status: 'loading' }]);
        sdk.observers[0].next(missing(false));
        expect(seen).toEqual([{ status: 'loading' }, { status: 'empty' }]);
    });

    it('reports listener errors', () => {
        const seen: PixelInfo[] = [];
        watchPixel(1, 1, (i) => seen.push(i));
        sdk.observers[0].error({ message: 'Missing or insufficient permissions.', code: 'permission-denied' });
        expect(seen[1]).toEqual({ status: 'error', message: 'Missing or insufficient permissions.' });
    });

    it('can be unsubscribed right away (StrictMode) and stays silent afterwards', () => {
        const seen: PixelInfo[] = [];
        const unsubscribe = watchPixel(1, 1, (i) => seen.push(i));
        unsubscribe();
        unsubscribe();
        expect(sdk.unsubscribed).toBe(1);
        sdk.observers[0].next(missing(false));
        expect(seen).toEqual([{ status: 'loading' }]);
    });

    it('rejects pixels outside the grid without subscribing', () => {
        const seen: PixelInfo[] = [];
        watchPixel(10_000, 0, (i) => seen.push(i))();
        expect(seen.map((i) => i.status)).toEqual(['loading', 'error']);
        expect(sdk.refs).toHaveLength(0);
    });
});
