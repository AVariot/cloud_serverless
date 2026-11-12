// Read-only smoke test of the data layer against the real Firestore project.
// Skipped unless FIRESTORE_SMOKE=1, so `npm test` never touches the network:
//   FIRESTORE_SMOKE=1 npx vitest run scripts/firestore.smoke.test.ts
import { deleteApp, initializeApp } from 'firebase/app';
import { initializeFirestore, memoryLocalCache, terminate } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { chunkId } from '../src/config';
import { ChunkSync } from '../src/data/ChunkSync';
import { FirestorePixelSource } from '../src/data/FirestorePixelSource';
import type { ChunkSink, SyncStats } from '../src/types';

const enabled = process.env.FIRESTORE_SMOKE === '1';
const projectId = process.env.VITE_FIREBASE_PROJECT_ID || 'servtkt-cloudnative-dev';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(enabled)(`FirestorePixelSource on ${projectId}`, () => {
    it('pages, listens, reports in-sync and drives ChunkSync to live', async () => {
        const app = initializeApp({ projectId }, `smoke-${Date.now()}`);
        const db = initializeFirestore(app, { localCache: memoryLocalCache() });
        const source = new FirestorePixelSource(db);
        const ids: string[] = [];
        for (let cy = 0; cy < 5; cy++) for (let cx = 0; cx < 5; cx++) ids.push(chunkId(cx, cy));

        try {
            // 1. One page over 25 chunks: in + orderBy(updated_at, __name__) + limit
            let t = performance.now();
            const page = await source.fetchPage(ids, null, 5000);
            console.log(`fetchPage(25 chunks): ${page.docs.length} docs, next=${page.next === null ? 'null' : 'cursor'}, ${Math.round(performance.now() - t)} ms`);
            if (page.next !== null) {
                const page2 = await source.fetchPage(ids, page.next, 5000);
                console.log(`fetchPage(cursor): ${page2.docs.length} docs`);
            }

            // 2. Listener for ~3 s: initial snapshot, fromCache transitions, in-sync events
            const events: { changes: number; fromCache: boolean; initial: boolean; ms: number }[] = [];
            const errors: Error[] = [];
            let inSync = 0;
            t = performance.now();
            const offSync = source.onInSync(() => inSync++);
            const unsub = source.listen(ids, 0, {
                next: (changes, meta) => events.push({ changes: changes.length, ...meta, ms: Math.round(performance.now() - t) }),
                error: (e) => errors.push(e),
            });
            await sleep(3000);
            unsub();
            offSync();
            console.log('listen events:', JSON.stringify(events), `inSync=${inSync}`, errors.length ? `errors=${errors.map((e) => e.message)}` : '');
            expect(errors).toEqual([]);
            expect(events[0]?.initial).toBe(true);
            expect(events.some((e) => !e.fromCache)).toBe(true);
            expect(inSync).toBeGreaterThan(0);

            // 3. ChunkSync end to end on a 2x2 view (+ ring = 3x3 chunks)
            const log: string[] = [];
            const sink: ChunkSink = {
                beginLoad: (cx, cy) => log.push(`begin ${cx}_${cy}`),
                applyPixels: (u) => log.push(`apply ${u.length}`),
                finishLoad: (cx, cy) => log.push(`finish ${cx}_${cy}`),
                evict: (cx, cy) => log.push(`evict ${cx}_${cy}`),
            };
            const stats: SyncStats[] = [];
            t = performance.now();
            const sync = new ChunkSync(source, sink, (s) => stats.push(s), { rebuildDebounceMs: 50 });
            sync.setView({ cx0: 0, cy0: 0, cx1: 1, cy1: 1 }, { x: 500, y: 500 });
            while (performance.now() - t < 10_000 && stats[stats.length - 1]?.status !== 'live') await sleep(50);
            const liveMs = Math.round(performance.now() - t);
            sync.dispose();
            console.log(`ChunkSync live after ${liveMs} ms; statuses: ${stats.map((s) => s.status).join(' > ')}`);
            console.log('last stats:', JSON.stringify(stats[stats.length - 1]));
            console.log('sink:', log.filter((l) => !l.startsWith('apply')).length, 'begin/finish calls,', log.filter((l) => l.startsWith('apply')).join(', ') || 'no pixels');
            expect(stats[stats.length - 1]).toMatchObject({ status: 'live', loaded: 9, live: 9, listeners: 1 });
        } finally {
            await terminate(db);
            await deleteApp(app);
        }
    }, 30_000);
});
