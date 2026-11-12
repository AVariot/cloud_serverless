import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, chunkId } from '../config';
import type { ChunkRect, ChunkSink, PixelUpdate, SyncStats } from '../types';
import { ChunkSync, type ChunkSyncOptions } from './ChunkSync';
import type { ListenHandlers, PageCursor, PixelChange, PixelDoc, PixelPage, PixelSource } from './PixelSource';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface PageRequest {
    ids: string[];
    cursor: PageCursor | null;
    pageSize: number;
    resolve(page: PixelPage): void;
    reject(e: Error): void;
}

interface FakeListener {
    ids: string[];
    since: number;
    handlers: ListenHandlers;
    active: boolean;
}

const chunkOfDoc = (d: PixelDoc) => chunkId(Math.floor(d.x / CHUNK_SIZE), Math.floor(d.y / CHUNK_SIZE));

/** Pages are either answered by hand (requests) or served from `server` right away */
class FakePixelSource implements PixelSource {
    readonly requests: PageRequest[] = [];
    readonly calls: string[][] = [];
    readonly listeners: FakeListener[] = [];
    readonly inSyncCbs = new Set<() => void>();
    server: PixelDoc[] | null = null;

    fetchPage(chunkIds: readonly string[], cursor: PageCursor | null, pageSize: number): Promise<PixelPage> {
        this.calls.push([...chunkIds]);
        if (this.server) {
            const wanted = new Set(chunkIds);
            const all = this.server.filter((d) => wanted.has(chunkOfDoc(d))).sort((a, b) => a.updatedAtMs - b.updatedAtMs);
            const start = typeof cursor === 'number' ? cursor : 0;
            const docs = all.slice(start, start + pageSize);
            return Promise.resolve({ docs, next: docs.length === pageSize ? start + pageSize : null });
        }
        return new Promise((resolve, reject) => this.requests.push({ ids: [...chunkIds], cursor, pageSize, resolve, reject }));
    }

    listen(chunkIds: readonly string[], sinceMs: number, handlers: ListenHandlers): () => void {
        const l: FakeListener = { ids: [...chunkIds], since: sinceMs, handlers, active: true };
        this.listeners.push(l);
        return () => {
            l.active = false;
        };
    }

    onInSync(cb: () => void): () => void {
        this.inSyncCbs.add(cb);
        return () => {
            this.inSyncCbs.delete(cb);
        };
    }

    get active(): FakeListener[] {
        return this.listeners.filter((l) => l.active);
    }

    listenerOf(id: string): FakeListener | undefined {
        return this.active.find((l) => l.ids.includes(id));
    }

    fireInSync() {
        for (const cb of [...this.inSyncCbs]) cb();
    }
}

class RecordingSink implements ChunkSink {
    readonly log: string[] = [];
    readonly pixels = new Map<string, number>();
    beginLoad(cx: number, cy: number) {
        this.log.push(`begin ${cx}_${cy}`);
    }
    applyPixels(updates: readonly PixelUpdate[]) {
        this.log.push(`apply ${updates.length}`);
        for (const u of updates) this.pixels.set(`${u.x}_${u.y}`, u.color);
    }
    finishLoad(cx: number, cy: number) {
        this.log.push(`finish ${cx}_${cy}`);
    }
    evict(cx: number, cy: number) {
        this.log.push(`evict ${cx}_${cy}`);
    }
    get evictions() {
        return this.log.filter((l) => l.startsWith('evict ')).map((l) => l.slice(6));
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAFETY = 300_000;

const rect = (cx0: number, cy0: number, cx1 = cx0, cy1 = cy0): ChunkRect => ({ cx0, cy0, cx1, cy1 });
const centerOf = (r: ChunkRect) => ({ x: ((r.cx0 + r.cx1 + 1) * CHUNK_SIZE) / 2, y: ((r.cy0 + r.cy1 + 1) * CHUNK_SIZE) / 2 });
const px = (x: number, y: number, color: number, updatedAtMs: number): PixelDoc => ({ x, y, color, updatedAtMs });
const change = (type: PixelChange['type'], x: number, y: number, color: number, updatedAtMs: number): PixelChange =>
    ({ type, x, y, color, updatedAtMs });

function idsOf(cx0: number, cy0: number, cx1: number, cy1: number): string[] {
    const ids: string[] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) ids.push(chunkId(cx, cy));
    return ids.sort();
}
const sorted = (ids: readonly string[]) => [...ids].sort();

/** Fake timers + microtasks (pages resolve through promises) */
async function tick(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

function serverSnapshot(l: FakeListener, docs: PixelDoc[] = [], initial = true) {
    l.handlers.next(docs.map((d) => ({ ...d, type: 'added' as const })), { fromCache: false, initial });
}

function setup(options: ChunkSyncOptions = {}, server: PixelDoc[] | null = null) {
    const source = new FakePixelSource();
    source.server = server;
    const sink = new RecordingSink();
    const stats: SyncStats[] = [];
    const sync = new ChunkSync(source, sink, (s) => stats.push(s), { now: () => Date.now(), safetyMs: SAFETY, ...options });
    const view = (r: ChunkRect | null, center = r ? centerOf(r) : { x: 0, y: 0 }) => sync.setView(r, center);
    return { source, sink, stats, sync, view, last: () => stats[stats.length - 1] };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('needed set', () => {
    it('expands the visible rect by the preload ring and clamps it to the grid', async () => {
        const { source, view, last } = setup({ preloadRing: 1 });

        view(rect(0, 0, 1, 1));
        await tick();
        expect(last().needed).toBe(9);
        expect(sorted(source.requests[0].ids)).toEqual(idsOf(0, 0, 2, 2));

        view(rect(18, 19, 19, 19));
        await tick();
        expect(last().needed).toBe(6); // 17..19 x 18..19
        expect(sorted(source.requests[1].ids)).toEqual(idsOf(17, 18, 19, 19));

        view(rect(-5, -5, -3, -3)); // ring does not reach the grid
        await tick();
        expect(last().needed).toBe(0);

        view(rect(-3, -3, -1, -1)); // ring reaches 0_0
        await tick();
        expect(last().needed).toBe(1);

        view(null);
        await tick();
        expect(last().needed).toBe(0);
    });

    it('rejects block sizes whose chunk list would not fit one `in` filter', () => {
        const make = (blockSize: number) => () => new ChunkSync(new FakePixelSource(), new RecordingSink(), () => {}, { blockSize });
        expect(make(6)).toThrow(RangeError);
        expect(make(0)).toThrow(RangeError);
        expect(make(5)).not.toThrow();
    });
});

describe('blocks', () => {
    it('groups chunks into fixed 5x5 blocks with one listener per block', async () => {
        const { source, view, last } = setup({ preloadRing: 1 }, []);

        view(rect(4, 4, 5, 5)); // + ring = 3..6, straddles 4 blocks
        await tick();
        await tick(250);
        expect(source.active.map((l) => sorted(l.ids)).sort()).toEqual(
            [idsOf(3, 3, 4, 4), idsOf(5, 3, 6, 4), idsOf(3, 5, 4, 6), idsOf(5, 5, 6, 6)].sort(),
        );

        view(rect(0, 0, 19, 19)); // whole map
        for (let i = 0; i < 10; i++) await tick();
        await tick(250);
        const active = source.active;
        expect(active).toHaveLength(16);
        for (const l of active) expect(l.ids.length).toBeLessThanOrEqual(25);
        expect(new Set(active.flatMap((l) => l.ids)).size).toBe(400);
        expect(last()).toMatchObject({ listeners: 16, live: 400, loaded: 400, loading: 0 });
    });

    it('runs at most maxConcurrentLoads jobs, nearest blocks first', async () => {
        const { source, view } = setup({ preloadRing: 0, maxConcurrentLoads: 3 });
        // 4 blocks; the center sits in chunk 6_6 (block 1,1), block 0,0 is the farthest
        view(rect(3, 3, 6, 6), { x: 6 * CHUNK_SIZE + 400, y: 6 * CHUNK_SIZE + 400 });
        await tick();
        expect(source.requests.map((r) => sorted(r.ids))).toEqual([idsOf(5, 5, 6, 6), idsOf(5, 3, 6, 4), idsOf(3, 5, 4, 6)]);

        source.requests[0].resolve({ docs: [], next: null });
        await tick();
        expect(sorted(source.requests[3].ids)).toEqual(idsOf(3, 3, 4, 4));
    });
});

describe('loading', () => {
    it('begins every chunk, applies each page, then finishes, before any listener', async () => {
        const { source, sink, view } = setup({ preloadRing: 0, pageSize: 2 });
        view(rect(0, 0, 1, 0));
        await tick();
        expect(sink.log).toEqual(['begin 0_0', 'begin 1_0']);
        const r1 = source.requests[0];
        expect(r1.cursor).toBeNull();
        expect(r1.pageSize).toBe(2);

        r1.resolve({ docs: [px(1, 1, 5, 100), px(600, 1, 6, 200)], next: 'c1' });
        await tick(1000);
        expect(sink.log).toEqual(['begin 0_0', 'begin 1_0', 'apply 2']);
        expect(source.listeners).toHaveLength(0); // no listener while loading

        const r2 = source.requests[1];
        expect(r2.cursor).toBe('c1');
        expect(r2.ids).toEqual(r1.ids);
        r2.resolve({ docs: [px(2, 2, 7, 300)], next: null });
        await tick();
        expect(sink.log).toEqual(['begin 0_0', 'begin 1_0', 'apply 2', 'apply 1', 'finish 0_0', 'finish 1_0']);
        expect(sink.pixels.get('600_1')).toBe(6);

        await tick(250);
        expect(source.active.map((l) => sorted(l.ids))).toEqual([['0_0', '1_0']]);
    });

    it('aborts a load between pages when none of its chunks is needed anymore', async () => {
        const { source, sink, view } = setup({ preloadRing: 0, lingerMs: 0 });
        view(rect(0, 0));
        await tick();
        view(rect(10, 10));
        await tick();
        expect(source.requests).toHaveLength(2);

        source.requests[0].resolve({ docs: [px(1, 1, 2, 10)], next: 'c' });
        await tick();
        expect(sink.log).toEqual(['begin 0_0', 'begin 10_10', 'apply 1', 'evict 0_0']);
        expect(source.requests).toHaveLength(2); // no further page

        view(rect(0, 0)); // needed again: reloaded from scratch
        await tick();
        expect(source.requests[2].ids).toEqual(['0_0']);
        expect(source.requests[2].cursor).toBeNull();
        expect(sink.log[sink.log.length - 1]).toBe('begin 0_0');
    });

    it('keeps loading a chunk that lingers (pan away and back), aborts once the linger expires', async () => {
        const { source, sink, view } = setup({ preloadRing: 0, lingerMs: 15_000 });
        view(rect(0, 0));
        await tick();
        view(rect(10, 10)); // 0_0 lingers while its first page is in flight
        await tick();
        source.requests[0].resolve({ docs: [px(1, 1, 2, 10)], next: 'c1' });
        await tick();
        expect(sink.evictions).toEqual([]);
        const page2 = source.requests.find((r) => r.cursor === 'c1');
        expect(page2?.ids).toEqual(['0_0']);

        view(rect(0, 0)); // back: same job, no restart
        await tick();
        expect(source.requests.filter((r) => r.ids[0] === '0_0' && r.cursor === null)).toHaveLength(1);

        view(rect(10, 10));
        await tick(15_000); // linger expires while page 2 is in flight
        page2!.resolve({ docs: [px(2, 2, 2, 20)], next: 'c2' });
        await tick();
        expect(sink.evictions).toEqual(['0_0']);
        expect(source.requests.some((r) => r.cursor === 'c2')).toBe(false);
    });

    it('retries a failed page with the same cursor, gives up after 5 failures, retries later', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1); // no jitter: backoff = base * 2^(n-1)
        const { source, sink, view, last } = setup({ preloadRing: 0, retryBaseMs: 1000 });
        view(rect(0, 0));
        await tick();
        source.requests[0].resolve({ docs: [px(1, 1, 1, 5)], next: 'c1' });
        await tick();

        source.requests[1].reject(new Error('unavailable'));
        await tick();
        expect(last().error).toBe('unavailable');
        await tick(999);
        expect(source.requests).toHaveLength(2);
        await tick(1);
        expect(source.requests[2].cursor).toBe('c1');

        source.requests[2].reject(new Error('unavailable'));
        await tick(2000);
        source.requests[3].reject(new Error('unavailable'));
        await tick(4000);
        source.requests[4].reject(new Error('unavailable'));
        await tick(8000);
        expect(source.requests).toHaveLength(6);
        source.requests[5].reject(new Error('still down'));
        await tick();
        expect(sink.log[sink.log.length - 1]).toBe('evict 0_0');
        expect(last()).toMatchObject({ loading: 0, loaded: 0, error: 'still down' });

        await tick(1000); // chunk retry backoff
        expect(source.requests).toHaveLength(7);
        expect(source.requests[6].cursor).toBeNull();
        expect(sink.log[sink.log.length - 1]).toBe('begin 0_0');
    });
});

describe('syncedAt and listener since', () => {
    it('uses maxSeen minus the load duration, or maxSeen at job start, never the client clock', async () => {
        const { source, view } = setup({ preloadRing: 0 });

        // 1. First load: nothing seen before; newest doc 1_000_000; pages took 2 s
        view(rect(0, 0));
        await tick();
        await tick(2000);
        source.requests[0].resolve({ docs: [px(1, 1, 3, 400_000), px(2, 2, 3, 1_000_000)], next: null });
        await tick();
        await tick(250);
        expect(source.listenerOf('0_0')?.since).toBe(1_000_000 - 2000 - SAFETY);

        // 2. Empty chunk: no doc in its pages, maxSeen at job start is the bound
        view(rect(10, 10));
        await tick();
        await tick(5000);
        source.requests[1].resolve({ docs: [], next: null });
        await tick();
        await tick(250);
        expect(source.listenerOf('10_10')?.since).toBe(1_000_000 - SAFETY);

        // 3. A newer doc seen mid-load (live delta from the lingering 0_0) raises the bound
        view(rect(15, 15));
        await tick();
        const l0 = source.listenerOf('0_0')!;
        serverSnapshot(l0, [px(3, 3, 4, 2_000_000)]);
        await tick(1000);
        source.requests[2].resolve({ docs: [], next: null });
        await tick();
        await tick(250);
        expect(source.listenerOf('15_15')?.since).toBe(2_000_000 - 1000 - SAFETY);
    });

    it('onInSync raises syncedAt only for chunks whose listener is confirmed by the server', async () => {
        const { source, sink, view } = setup({ preloadRing: 0 }, []);
        view(rect(0, 0, 5, 0)); // blocks (0,0) [0_0..4_0] and (1,0) [5_0]
        await tick();
        await tick(250);
        const la = source.listenerOf('0_0')!;
        const lb = source.listenerOf('5_0')!;
        expect(la.since).toBe(-SAFETY); // empty chunks, nothing seen yet
        expect(lb.since).toBe(-SAFETY);

        serverSnapshot(la, [px(1, 1, 9, 500_000)]);
        lb.handlers.next([], { fromCache: true, initial: true }); // not confirmed
        source.fireInSync();

        // Leave, let the linger expire, come back: no reload, `since` from the old syncedAt
        view(rect(10, 10));
        await tick();
        await tick(15_000 + 250);
        expect(la.active).toBe(false);
        expect(lb.active).toBe(false);
        const loadsBefore = source.calls.length;
        const beginsBefore = sink.log.filter((l) => l.startsWith('begin')).length;

        view(rect(0, 0, 5, 0));
        await tick();
        await tick(250);
        expect(source.calls.length).toBe(loadsBefore);
        expect(sink.log.filter((l) => l.startsWith('begin')).length).toBe(beginsBefore);
        expect(source.listenerOf('0_0')?.since).toBe(500_000 - SAFETY);
        expect(source.listenerOf('5_0')?.since).toBe(-SAFETY);
    });
});

describe('linger and eviction', () => {
    it('shrinks lazily: a chunk past its linger stays in the listener, which closes once the block is idle', async () => {
        const { source, sink, view, last } = setup({ preloadRing: 0, lingerMs: 15_000 }, []);
        view(rect(0, 0, 1, 0));
        await tick();
        await tick(250);
        const l1 = source.active[0];
        expect(sorted(l1.ids)).toEqual(['0_0', '1_0']);
        serverSnapshot(l1);

        view(rect(1, 0)); // 0_0 lingers
        await tick(10_000);
        view(rect(0, 0, 1, 0)); // back within the linger: nothing changes
        await tick(10_000);
        view(rect(1, 0));
        await tick(15_000 + 250); // linger expired: no rebuild (no re-read of the since window)
        expect(source.listeners).toHaveLength(1);
        expect(l1.active).toBe(true);
        expect(last()).toMatchObject({ live: 2, listeners: 1 });

        // Its deltas still arrive and keep the cached chunk fresh
        l1.handlers.next([change('modified', 3, 3, 8, 50)], { fromCache: false, initial: false });
        expect(sink.pixels.get('3_3')).toBe(8);

        view(rect(0, 0, 1, 0)); // rejoining a chunk that is still covered costs nothing
        await tick(250);
        expect(source.listeners).toHaveLength(1);

        view(rect(10, 10)); // nothing of block 0 live after the linger: listener closed
        await tick(15_000 + 250);
        expect(l1.active).toBe(false);
        expect(source.listenerOf('0_0')).toBeUndefined();
    });

    it('drops the kept non-live chunks when the listener is re-created to add chunks', async () => {
        const { source, view } = setup({ preloadRing: 0, lingerMs: 1000 }, []);
        view(rect(0, 0, 1, 0));
        await tick();
        await tick(250);
        view(rect(1, 0));
        await tick(1000 + 250); // 0_0 not live anymore, still covered
        expect(sorted(source.active[0].ids)).toEqual(['0_0', '1_0']);

        view(rect(1, 0, 2, 0)); // 2_0 loads and must join: rebuild anyway, without 0_0
        await tick();
        await tick(250);
        expect(source.active.map((l) => sorted(l.ids))).toEqual([['1_0', '2_0']]);
    });

    it('evicts least-recently-needed cached chunks beyond maxCachedChunks, never needed ones', async () => {
        const painted = [px(1, 1, 1, 1), px(501, 1, 1, 1), px(1001, 1, 1, 1), px(2501, 2501, 1, 1), px(3001, 2501, 1, 1), px(3501, 2501, 1, 1)];
        const { sink, view, last } = setup({ preloadRing: 0, lingerMs: 0, maxCachedChunks: 2 }, painted);
        for (const cx of [0, 1, 2]) {
            view(rect(cx, 0));
            await tick();
        }
        expect(sink.evictions).toEqual(['0_0']);
        expect(last().loaded).toBe(2);

        view(rect(5, 5, 7, 5)); // 3 needed painted chunks > maxCachedChunks
        await tick();
        expect(sink.evictions).toEqual(['0_0', '1_0', '2_0']);
        expect(last().loaded).toBe(3);
    });

    it('does not count empty chunks toward maxCachedChunks (overview <-> close-up does not reload them)', async () => {
        const { source, sink, view, last } = setup({ preloadRing: 0, lingerMs: 0, maxCachedChunks: 1 }, [px(1, 1, 3, 1)]);
        view(rect(0, 0, 4, 4)); // 25 chunks, only 0_0 painted
        await tick();
        view(rect(10, 10));
        await tick();
        expect(sink.evictions).toEqual([]);
        expect(last().loaded).toBe(26);

        // Once a live delta paints 10_10, two painted chunks exceed the budget: the cached one goes
        await tick(250);
        source.listenerOf('10_10')!.handlers.next([change('added', 5001, 5001, 3, 2)], { fromCache: false, initial: true });
        expect(sink.evictions).toEqual(['0_0']);
    });

    it('a chunk evicted while its listener lives is covered again after its reload', async () => {
        const painted = [px(1, 1, 1, 1), px(501, 1, 1, 1)];
        const { source, sink, view, sync } = setup({ preloadRing: 0, lingerMs: 0, maxCachedChunks: 1 }, painted);
        view(rect(0, 0, 1, 0));
        await tick();
        await tick(250);
        const l1 = source.active[0];
        serverSnapshot(l1);
        expect(sync.isLive(1, 0)).toBe(true);

        view(rect(0, 0)); // 1_0 cached, then evicted (2 painted > 1): l1 is kept (lazy shrink)
        await tick();
        expect(sink.evictions).toEqual(['1_0']);
        expect(l1.active).toBe(true);
        expect(sync.isLive(1, 0)).toBe(false);

        view(rect(0, 0, 1, 0)); // reloaded in one fast page, inside the old listener's lifetime
        await tick();
        // l1 still lists 1_0 but must not apply its changes: they could interleave with the pages
        l1.handlers.next([change('modified', 502, 2, 9, 5)], { fromCache: false, initial: false });
        expect(sink.pixels.has('502_2')).toBe(false);

        await tick(250);
        const l2 = source.listenerOf('1_0')!;
        expect(l2).not.toBe(l1);
        expect(l1.active).toBe(false);
        expect(sync.isLive(1, 0)).toBe(false); // not confirmed by the server yet
        serverSnapshot(l2);
        expect(sync.isLive(1, 0)).toBe(true);
        l2.handlers.next([change('modified', 503, 3, 7, 6)], { fromCache: false, initial: false });
        expect(sink.pixels.get('503_3')).toBe(7);
    });

    it('reloads a cached chunk rejoining long after the block listener moved on, instead of dragging since back', async () => {
        const HOUR = 3_600_000;
        const { source, sink, view } = setup({ preloadRing: 0, lingerMs: 1000, rejoinMaxLagMs: 30 * 60_000 }, []);
        view(rect(0, 0, 1, 0));
        await tick();
        await tick(250);
        serverSnapshot(source.active[0], [px(1, 1, 1, 1_000_000)]);
        source.fireInSync(); // syncedAt(0_0, 1_0) = 1_000_000

        view(rect(10, 10)); // both leave, listener closes after the linger
        await tick(1000 + 250);
        expect(source.listenerOf('0_0')).toBeUndefined();

        view(rect(0, 0)); // 0_0 rejoins alone and gets an hour fresher
        await tick(250);
        const l0 = source.listenerOf('0_0')!;
        expect(l0.since).toBe(1_000_000 - SAFETY);
        serverSnapshot(l0, [px(2, 2, 1, 1_000_000 + HOUR)]);
        source.fireInSync();
        const loadsBefore = source.calls.length;

        view(rect(0, 0, 1, 0)); // 1_0 is an hour behind: reload it
        await tick(250);
        await tick();
        expect(source.calls.slice(loadsBefore)).toEqual([['1_0']]);
        expect(sink.log.slice(-3)).toEqual(['evict 1_0', 'begin 1_0', 'finish 1_0']);
        await tick(250);
        expect(source.listenerOf('1_0')?.since).toBe(1_000_000 + HOUR - SAFETY);
    });

    it('lets a cached chunk with a small lag rejoin without reload', async () => {
        const { source, view } = setup({ preloadRing: 0, lingerMs: 1000, rejoinMaxLagMs: 30 * 60_000 }, []);
        view(rect(0, 0, 1, 0));
        await tick();
        await tick(250);
        serverSnapshot(source.active[0], [px(1, 1, 1, 1_000_000)]);
        source.fireInSync();
        view(rect(10, 10));
        await tick(1000 + 250);
        view(rect(0, 0));
        await tick(250);
        serverSnapshot(source.listenerOf('0_0')!, [px(2, 2, 1, 1_000_000 + 60_000)]);
        source.fireInSync();
        const loadsBefore = source.calls.length;

        view(rect(0, 0, 1, 0));
        await tick(250);
        expect(source.calls.length).toBe(loadsBefore);
        expect(source.listenerOf('1_0')?.since).toBe(1_000_000 - SAFETY);
    });
});

describe('listeners', () => {
    it('applies changes as deltas: removed -> 0, chunks outside the listener ignored', async () => {
        const { source, sink, view, last } = setup({ preloadRing: 0 }, []);
        view(rect(0, 0));
        await tick();
        await tick(250);
        const l = source.active[0];
        l.handlers.next([change('added', 1, 1, 4, 10), change('added', 700, 1, 5, 11)], { fromCache: false, initial: true });
        expect(sink.pixels.get('1_1')).toBe(4);
        expect(sink.pixels.has('700_1')).toBe(false);
        l.handlers.next([change('modified', 1, 1, 6, 20)], { fromCache: false, initial: false });
        expect(sink.pixels.get('1_1')).toBe(6);
        l.handlers.next([change('removed', 1, 1, 6, 20)], { fromCache: false, initial: false });
        expect(sink.pixels.get('1_1')).toBe(0);
        await tick();
        expect(last().docsRead).toBe(4);
    });

    it('re-creates a failed listener with exponential backoff, reset by a server snapshot', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const { source, view, last } = setup({ preloadRing: 0, retryBaseMs: 1000 }, []);
        view(rect(0, 0));
        await tick();
        await tick(250);
        const l1 = source.active[0];
        serverSnapshot(l1);
        await tick();
        expect(last().status).toBe('live');

        l1.handlers.error(new Error('boom'));
        await tick();
        expect(last()).toMatchObject({ status: 'error', error: 'boom', listeners: 0 });
        await tick(1000);
        const l2 = source.listeners[1];
        expect(l2.ids).toEqual(['0_0']);
        expect(l2.since).toBe(l1.since);
        expect(last().status).toBe('error'); // until the new listener is confirmed

        l2.handlers.error(new Error('boom'));
        await tick(1999);
        expect(source.listeners).toHaveLength(2);
        await tick(1);
        expect(source.listeners).toHaveLength(3);

        serverSnapshot(source.listeners[2]);
        await tick();
        expect(last().status).toBe('live');
        expect(last().error).toBeUndefined();

        source.listeners[2].handlers.error(new Error('boom'));
        await tick(1000); // back to the base delay
        expect(source.listeners).toHaveLength(4);
    });

    it('refreshes the largest listeners when the summed result sets exceed maxTotalListenerDocs', async () => {
        const { source, view } = setup({ preloadRing: 0, maxListenerDocs: 1000, maxTotalListenerDocs: 10 }, []);
        view(rect(0, 0, 5, 0)); // blocks (0,0) and (1,0)
        await tick();
        await tick(250);
        const la = source.listenerOf('0_0')!;
        const lb = source.listenerOf('5_0')!;
        serverSnapshot(la);
        serverSnapshot(lb);
        serverSnapshot(lb, [1, 2, 3, 4].map((i) => px(2500 + i, 1, 1, i * 100_000)), false);
        serverSnapshot(la, [1, 2, 3, 4, 5, 6, 7, 8].map((i) => px(i, 1, 1, i * 100_000)), false); // 12 > 10
        source.fireInSync();
        await tick(250);
        expect(la.active).toBe(false);
        expect(lb.active).toBe(true);
        expect(source.listenerOf('0_0')?.since).toBe(800_000 - SAFETY);
    });

    it('isLive: loaded and covered by a listener whose latest snapshot came from the server', async () => {
        const { source, view, sync } = setup({ preloadRing: 0, lingerMs: 0 }, []);
        expect(sync.isLive(0, 0)).toBe(false);
        view(rect(0, 0));
        await tick();
        expect(sync.isLive(0, 0)).toBe(false); // loaded, listener not created yet
        await tick(250);
        const l = source.active[0];
        expect(sync.isLive(0, 0)).toBe(false); // listener not confirmed
        l.handlers.next([], { fromCache: true, initial: true });
        expect(sync.isLive(0, 0)).toBe(false);
        l.handlers.next([], { fromCache: false, initial: false });
        expect(sync.isLive(0, 0)).toBe(true);
        l.handlers.next([], { fromCache: true, initial: false }); // offline
        expect(sync.isLive(0, 0)).toBe(false);
        l.handlers.next([], { fromCache: false, initial: false });
        expect(sync.isLive(0, 0)).toBe(true);
        expect(sync.isLive(1, 0)).toBe(false);
        expect(sync.isLive(-1, 0)).toBe(false);
        expect(sync.isLive(20, 0)).toBe(false);
        expect(sync.isLive(0.5, 0)).toBe(false);

        view(rect(10, 10)); // 0_0 cached, its block idle: listener closed
        await tick(250);
        expect(l.active).toBe(false);
        expect(sync.isLive(0, 0)).toBe(false);

        view(rect(0, 0));
        await tick(250);
        serverSnapshot(source.listenerOf('0_0')!);
        expect(sync.isLive(0, 0)).toBe(true);
        source.listenerOf('0_0')!.handlers.error(new Error('boom'));
        expect(sync.isLive(0, 0)).toBe(false);
        sync.dispose();
        expect(sync.isLive(0, 0)).toBe(false);
    });

    it('re-creates a listener whose result set outgrew maxListenerDocs, with a fresher since', async () => {
        const { source, view } = setup({ preloadRing: 0, maxListenerDocs: 3 }, []);
        view(rect(0, 0));
        await tick();
        await tick(250);
        const l1 = source.active[0];
        serverSnapshot(l1);
        serverSnapshot(l1, [px(1, 1, 1, 600_000), px(2, 1, 1, 700_000), px(3, 1, 1, 800_000), px(4, 1, 1, 900_000)], false);
        source.fireInSync();
        await tick(250);
        expect(l1.active).toBe(false);
        expect(source.active[0].ids).toEqual(['0_0']);
        expect(source.active[0].since).toBe(900_000 - SAFETY);
    });
});

describe('status', () => {
    it('is live when there is nothing to load or listen to', async () => {
        const { last } = setup();
        await tick();
        expect(last()).toMatchObject({ status: 'live', needed: 0, listeners: 0 });
    });

    it('goes connecting -> live -> offline -> live', async () => {
        const { source, view, last } = setup({ preloadRing: 0 });
        view(rect(0, 0));
        await tick();
        expect(last()).toMatchObject({ status: 'connecting', loading: 1 });
        source.requests[0].resolve({ docs: [], next: null });
        await tick();
        expect(last()).toMatchObject({ status: 'connecting', loaded: 1, listeners: 0 });
        await tick(250);
        const l = source.active[0];
        l.handlers.next([], { fromCache: true, initial: true });
        await tick();
        expect(last().status).toBe('connecting');
        l.handlers.next([], { fromCache: false, initial: false });
        await tick();
        expect(last()).toMatchObject({ status: 'live', live: 1, listeners: 1, loaded: 1 });
        l.handlers.next([], { fromCache: true, initial: false });
        await tick();
        expect(last().status).toBe('offline');
        l.handlers.next([], { fromCache: false, initial: false });
        await tick();
        expect(last().status).toBe('live');
    });

    it('treats a first snapshot from cache as pending, not offline', async () => {
        const { source, view, last } = setup({ preloadRing: 0 }, []);
        view(rect(0, 0));
        await tick();
        await tick(250);
        serverSnapshot(source.active[0]);
        await tick();
        expect(last().status).toBe('live');

        view(rect(0, 0, 1, 0)); // 1_0 joins: the block listener is re-created
        await tick();
        await tick(250);
        const l2 = source.listenerOf('1_0')!;
        // e.g. docs held in the memory cache by the inspector's single-doc listener
        l2.handlers.next([change('added', 1, 1, 2, 5)], { fromCache: true, initial: true });
        await tick();
        expect(last().status).toBe('live');
        l2.handlers.next([], { fromCache: false, initial: false });
        l2.handlers.next([], { fromCache: true, initial: false }); // after a server snapshot: offline
        await tick();
        expect(last().status).toBe('offline');
    });

    it('reports repeated load failures as error while needed chunks are missing', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const { source, view, last } = setup({ preloadRing: 0, retryBaseMs: 1000 });
        view(rect(0, 0));
        await tick();
        source.requests[0].reject(new Error('Quota exceeded.'));
        await tick();
        expect(last()).toMatchObject({ status: 'connecting', error: 'Quota exceeded.' }); // one failure: retried quietly
        await tick(1000);
        source.requests[1].reject(new Error('Quota exceeded.'));
        await tick();
        expect(last()).toMatchObject({ status: 'error', error: 'Quota exceeded.' });

        await tick(2000);
        source.requests[2].resolve({ docs: [], next: null });
        await tick();
        expect(last().status).toBe('connecting'); // loaded, listener pending
        expect(last().error).toBeUndefined();
    });

    it('follows window online/offline events', async () => {
        const win = new EventTarget();
        const nav = { onLine: true };
        vi.stubGlobal('window', win);
        vi.stubGlobal('navigator', nav);
        const { sync, stats, last } = setup();
        await tick();
        expect(last().status).toBe('live');
        nav.onLine = false;
        win.dispatchEvent(new Event('offline'));
        await tick();
        expect(last().status).toBe('offline');
        nav.onLine = true;
        win.dispatchEvent(new Event('online'));
        await tick();
        expect(last().status).toBe('live');

        sync.dispose();
        const count = stats.length;
        win.dispatchEvent(new Event('offline'));
        await tick();
        expect(stats.length).toBe(count);
    });

    it('only emits stats when something changed', async () => {
        const { view, stats } = setup({ preloadRing: 0 }, []);
        view(rect(0, 0));
        await tick();
        await tick(250);
        const count = stats.length;
        view(rect(0, 0), { x: 10, y: 10 }); // same rect, other center
        await tick(1000);
        expect(stats.length).toBe(count);
    });
});

describe('dispose', () => {
    it('unsubscribes everything, cancels timers and goes silent', async () => {
        const { sync, source, sink, stats, view } = setup({ preloadRing: 0 });
        view(rect(0, 0, 1, 0));
        await tick();
        source.requests[0].resolve({ docs: [], next: null });
        await tick();
        await tick(250);
        const l1 = source.active[0];
        view(rect(10, 10)); // pending page + linger timer
        await tick();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        sync.dispose();
        expect(source.active).toHaveLength(0);
        expect(source.inSyncCbs.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);

        const logLength = sink.log.length;
        const statsCount = stats.length;
        source.requests[1].resolve({ docs: [px(5001, 5001, 1, 1)], next: null });
        l1.handlers.next([change('added', 1, 1, 1, 1)], { fromCache: false, initial: true });
        l1.handlers.error(new Error('late'));
        view(rect(3, 3));
        await tick(60_000);
        expect(sink.log.length).toBe(logLength);
        expect(stats.length).toBe(statsCount);
        expect(source.requests).toHaveLength(2);
    });
});
