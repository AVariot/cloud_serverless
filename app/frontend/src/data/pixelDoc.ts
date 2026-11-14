import { doc, onSnapshot } from 'firebase/firestore';
import { isInGrid, pixelDocId } from '../config';
import type { PixelInfo } from '../types';
import { getDb } from './firebase';
import { paletteColor, timestampToMillis } from './FirestorePixelSource';

/**
 * Live view of one pixel document (pixels/{x}_{y}) for the inspector: author,
 * update time and color, updated in real time while subscribed.
 * Calls `cb` with { status: 'loading' } first (synchronously), then 'empty',
 * 'ready' or 'error'. Returns the unsubscribe function, safe to call at any
 * time, including right away (React StrictMode mounts twice).
 */
export function watchPixel(x: number, y: number, cb: (info: PixelInfo) => void): () => void {
    let active = true;
    let last: PixelInfo | null = null;
    const emit = (info: PixelInfo) => {
        // Metadata-only snapshots (fromCache flips) repeat the same content: skip them
        if (!active || (last !== null && samePixelInfo(last, info))) return;
        last = info;
        cb(info);
    };

    emit({ status: 'loading' });
    if (!isInGrid(x, y)) {
        emit({ status: 'error', message: `Pixel (${x}, ${y}) is outside the grid` });
        return () => { active = false; };
    }

    let unsub: (() => void) | null = null;
    try {
        // includeMetadataChanges: offline, the first snapshot comes from the (empty)
        // cache and says "missing" without that being true. It is ignored, and the
        // server confirmation (same data, fromCache false) must still reach us.
        unsub = onSnapshot(doc(getDb(), 'pixels', pixelDocId(x, y)), { includeMetadataChanges: true }, {
            next: (snap) => {
                if (!snap.exists()) {
                    if (!snap.metadata.fromCache) emit({ status: 'empty' });
                    return;
                }
                const data = snap.data();
                emit({
                    status: 'ready',
                    color: paletteColor(data.color),
                    userId: typeof data.user_id === 'string' ? data.user_id : '',
                    updatedAtMs: timestampToMillis(data.updated_at),
                });
            },
            error: (e) => emit({ status: 'error', message: e.message || e.code }),
        });
    } catch (e) {
        // getDb() throws when the project id is not configured
        emit({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }

    return () => {
        active = false;
        const u = unsub;
        unsub = null;
        u?.();
    };
}

function samePixelInfo(a: PixelInfo, b: PixelInfo): boolean {
    if (a.status !== b.status) return false;
    if (a.status === 'ready' && b.status === 'ready') {
        return a.color === b.color && a.userId === b.userId && a.updatedAtMs === b.updatedAtMs;
    }
    if (a.status === 'error' && b.status === 'error') return a.message === b.message;
    return true;
}
