// Keeps the engine's chunks in sync with Firestore: paginated initial loads of
// the chunks around the view, then real-time deltas through at most one
// listener per fixed block of chunks. Depends only on PixelSource + ChunkSink,
// so the whole algorithm is unit-tested with a fake source.
//
// Gap-free argument (why pages + `updated_at > since` listeners never miss a write)
// ------------------------------------------------------------------------------
// D = max Pub/Sub delivery delay: a doc written at server time W has
// updated_at >= W - D. safetyMs must be >= D.
// * A load job paginates by (updated_at, id). Every doc whose last write happened
//   before the first page ran (server time T1) has a fixed position, the cursor only
//   moves forward, so some page returns it with its final value. Docs written after
//   T1 may be missed or stale, but they have updated_at >= T1 - D.
// * syncedAt of the loaded chunks is a lower bound of T1 in SERVER time (see
//   finishJob), so a listener with since = syncedAt - safetyMs re-delivers every doc
//   the pages may have missed, and every later write.
// * A listener in sync at server time T has delivered every matching doc written
//   before T; later writes have updated_at >= T - D. maxSeen (max updated_at ever
//   received) is <= T, so onInSync may raise syncedAt to maxSeen.
// * A chunk joins a listener only after finishLoad, and listeners always carry the
//   latest value of a doc, so applying their changes after the pages is correct
//   without per-pixel timestamps. A chunk that leaves the listeners keeps its
//   syncedAt; when it rejoins, `since` covers everything written meanwhile.
// The client clock is never compared with server times (it can be minutes off);
// it is only used for durations, which are offset-free.
//
// Known limit: correctness needs every Pub/Sub delivery delay to be <= safetyMs. A
// subscription backlog longer than that (worker down, retries piling up) can write
// a doc whose updated_at is already older than an in-sync client's `since`: that
// client never sees it until the chunk is reloaded. Not fixable here without
// polling (forbidden) or a backend change (e.g. a write-time field to listen on).

import { CHUNK_SIZE, CHUNKS_PER_SIDE, TOTAL_CHUNKS, chunkId, chunkKey, chunkKeyOfPixel, isInGrid } from '../config';
import type { ChunkRect, ChunkSink, PixelUpdate, SyncStats, SyncStatus } from '../types';
import type { PageCursor, PixelChange, PixelDoc, PixelPage, PixelSource } from './PixelSource';

export interface ChunkSyncOptions {
    /** Chunks per side of a listener block, default 5 (5x5 = 25 <= 30 'in' values) */
    blockSize?: number;
    /** Docs per page of an initial load, default 5000 */
    pageSize?: number;
    /** Load jobs running at once, default 3 */
    maxConcurrentLoads?: number;
    /** Extra chunks around the visible rect, default 1 */
    preloadRing?: number;
    /** Keep a chunk live (and its load running) after it leaves the view, default 15000 */
    lingerMs?: number;
    /** Delta re-read margin for out-of-order delivery (>= max Pub/Sub delay), default 300000 */
    safetyMs?: number;
    /**
     * Loaded chunks holding at least one painted pixel kept in memory, default 400.
     * Empty chunks cost nothing in the engine and are never evicted; needed and
     * lingering chunks are never evicted either.
     */
    maxCachedChunks?: number;
    /** Delay between a block's live set change and its listener rebuild, default 250 */
    rebuildDebounceMs?: number;
    /** Listener/page error backoff base, default 1000 (doubles up to 30000, jittered) */
    retryBaseMs?: number;
    /**
     * A listener's result set (every doc changed after `since`) only grows while it
     * lives, and the SDK keeps it in memory. Past this many docs the listener is
     * re-created with a fresher `since`. Default 20000.
     */
    maxListenerDocs?: number;
    /** Same, summed over every listener: the largest ones are refreshed first. Default 60000 */
    maxTotalListenerDocs?: number;
    /**
     * A cached chunk rejoining a block whose listener is this much fresher is
     * reloaded instead, so it does not drag the whole block's `since` back.
     * Default 1800000 (30 min).
     */
    rejoinMaxLagMs?: number;
    /** Monotonic clock (ms) for durations and timer deadlines only. Default performance.now */
    now?: () => number;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_PAGE_FAILURES = 5;
/** Consecutive page failures before the status turns to 'error' (one transient failure is retried quietly) */
const LOAD_ERROR_STATUS_STREAK = 2;
const MAX_IN_VALUES = 30;
const N = CHUNKS_PER_SIDE;

// Chunk states (plain numbers: erasableSyntaxOnly forbids enums)
const UNLOADED = 0;
const LOADING = 1;
const LOADED = 2;

// Latest snapshot of a block listener
const SNAP_NONE = 0;
const SNAP_CACHE = 1;
const SNAP_SERVER = 2;

type Timer = ReturnType<typeof setTimeout>;

interface Block {
    /** Every chunk key of the block (static) */
    readonly keys: readonly number[];
    /** Id of the current listener, 0 = none */
    token: number;
    unsub: (() => void) | null;
    /**
     * Chunks in the current listener's query. Those with coveredBy === token get its
     * changes applied; a chunk evicted meanwhile stays in the query but is filtered.
     */
    listenKeys: readonly number[];
    snap: number;
    /** The current listener has delivered a server (non-fromCache) snapshot */
    everServer: boolean;
    /** Size of the current listener's result set, at its first server snapshot, and the refresh trigger */
    docCount: number;
    initialDocs: number;
    refreshAt: number;
    /** Re-create the listener even if its coverage is complete (result set too large) */
    refresh: boolean;
    rebuildTimer: Timer | null;
    retryTimer: Timer | null;
    /** Consecutive listener failures (backoff exponent), reset by a server snapshot */
    failures: number;
    /** Set while the listener is dead or retrying after an error */
    error: string | null;
    readonly runRebuild: () => void;
    readonly runRetry: () => void;
}

interface Job {
    readonly keys: readonly number[];
    readonly ids: readonly string[];
    /** maxSeen when the job started: a lower bound of the server time of its first page */
    readonly startMaxSeen: number;
    /** Monotonic clock just before the first page request */
    readonly startedAt: number;
}

const EMPTY_KEYS: readonly number[] = [];

export class ChunkSync {
    private readonly source: PixelSource;
    private readonly sink: ChunkSink;
    private readonly onStats: (s: SyncStats) => void;
    private readonly now: () => number;

    private readonly blockSize: number;
    private readonly pageSize: number;
    private readonly maxConcurrentLoads: number;
    private readonly preloadRing: number;
    private readonly lingerMs: number;
    private readonly safetyMs: number;
    private readonly maxCachedChunks: number;
    private readonly rebuildDebounceMs: number;
    private readonly retryBaseMs: number;
    private readonly maxListenerDocs: number;
    private readonly maxTotalListenerDocs: number;
    private readonly rejoinMaxLagMs: number;

    // Per-chunk state, indexed by chunkKey (typed arrays: no per-chunk objects)
    private readonly state = new Uint8Array(TOTAL_CHUNKS);
    private readonly needed = new Uint8Array(TOTAL_CHUNKS);
    private readonly lingering = new Uint8Array(TOTAL_CHUNKS);
    private readonly lingerDeadline = new Float64Array(TOTAL_CHUNKS);
    /** LRU clock value when the chunk last stopped being needed */
    private readonly lastNeeded = new Float64Array(TOTAL_CHUNKS);
    /** Server ms up to which the chunk is known complete */
    private readonly syncedAt = new Float64Array(TOTAL_CHUNKS);
    /** Token of the listener whose changes apply to the chunk, 0 = none */
    private readonly coveredBy = new Int32Array(TOTAL_CHUNKS);
    /** The chunk received a non-zero pixel since it started loading (it costs engine memory) */
    private readonly hasInk = new Uint8Array(TOTAL_CHUNKS);
    /** Monotonic ms before which a chunk whose load failed is not retried */
    private readonly retryAt = new Float64Array(TOTAL_CHUNKS);
    private readonly loadFailures = new Uint8Array(TOTAL_CHUNKS);
    private readonly blockOf = new Uint16Array(TOTAL_CHUNKS);
    private readonly jobOf: (Job | null)[] = new Array<Job | null>(TOTAL_CHUNKS).fill(null);

    private readonly blocks: Block[] = [];
    private readonly blockDist: Float64Array;

    /** Needed rect (visible + ring, clamped), null = nothing needed */
    private rect: ChunkRect | null = null;
    private centerX = 0;
    private centerY = 0;

    private neededCount = 0;
    /** Needed chunks not in LOADED state (loading, queued or waiting for a retry) */
    private neededNotLoaded = 0;
    private loadingCount = 0;
    private loadedCount = 0;
    private inkedCount = 0;
    /** Chunks with coveredBy !== 0 */
    private liveCount = 0;
    private listenerCount = 0;
    /** Sum of the active listeners' result set sizes */
    private listenerDocs = 0;
    private runningJobs = 0;

    /** Max updated_at ever received: a lower bound of the server's current time */
    private maxSeen = 0;
    private docsRead = 0;
    private lruTick = 0;
    private nextToken = 1;
    /** A listener has been in sync with the server at least once */
    private wasLive = false;
    private browserOffline = false;
    private loadError: string | null = null;
    /** Consecutive page failures, all jobs together; reset by any successful page */
    private loadFailStreak = 0;
    private disposed = false;

    /** Lingering chunks in deadline order (lingerMs is constant, so insertion order) */
    private readonly lingerOrder = new Set<number>();
    private lingerTimer: Timer | null = null;
    private pumpTimer: Timer | null = null;
    private pumpDue = 0;
    /** One-shot timers (page backoff) to cancel on dispose */
    private readonly timers = new Set<Timer>();

    private statsQueued = false;
    private lastStats: SyncStats | null = null;

    private readonly unsubInSync: () => void;
    private readonly removeWindowListeners: (() => void) | null = null;

    constructor(source: PixelSource, sink: ChunkSink, onStats: (s: SyncStats) => void, options: ChunkSyncOptions = {}) {
        this.source = source;
        this.sink = sink;
        this.onStats = onStats;
        this.blockSize = options.blockSize ?? 5;
        this.pageSize = options.pageSize ?? 5000;
        this.maxConcurrentLoads = options.maxConcurrentLoads ?? 3;
        this.preloadRing = options.preloadRing ?? 1;
        this.lingerMs = options.lingerMs ?? 15_000;
        this.safetyMs = options.safetyMs ?? 300_000;
        this.maxCachedChunks = options.maxCachedChunks ?? 400;
        this.rebuildDebounceMs = options.rebuildDebounceMs ?? 250;
        this.retryBaseMs = options.retryBaseMs ?? 1000;
        this.maxListenerDocs = options.maxListenerDocs ?? 20_000;
        this.maxTotalListenerDocs = options.maxTotalListenerDocs ?? 60_000;
        this.rejoinMaxLagMs = options.rejoinMaxLagMs ?? 30 * 60_000;
        this.now = options.now ?? defaultClock();

        const B = this.blockSize;
        if (!Number.isInteger(B) || B < 1 || B * B > MAX_IN_VALUES) {
            throw new RangeError(`blockSize must be an integer with blockSize^2 <= ${MAX_IN_VALUES}`);
        }
        if (!Number.isInteger(this.pageSize) || this.pageSize < 1) throw new RangeError('pageSize must be a positive integer');
        if (!Number.isInteger(this.preloadRing) || this.preloadRing < 0) throw new RangeError('preloadRing must be a non-negative integer');
        if (this.maxConcurrentLoads < 1) throw new RangeError('maxConcurrentLoads must be >= 1');

        // Fixed spatial partition: panning only rebuilds the blocks it touches
        const perSide = Math.ceil(N / B);
        for (let by = 0; by < perSide; by++) {
            for (let bx = 0; bx < perSide; bx++) {
                const index = this.blocks.length;
                const keys: number[] = [];
                for (let cy = by * B; cy < Math.min(N, (by + 1) * B); cy++) {
                    for (let cx = bx * B; cx < Math.min(N, (bx + 1) * B); cx++) {
                        const k = chunkKey(cx, cy);
                        keys.push(k);
                        this.blockOf[k] = index;
                    }
                }
                const block: Block = {
                    keys,
                    token: 0,
                    unsub: null,
                    listenKeys: EMPTY_KEYS,
                    snap: SNAP_NONE,
                    everServer: false,
                    docCount: 0,
                    initialDocs: 0,
                    refreshAt: Infinity,
                    refresh: false,
                    rebuildTimer: null,
                    retryTimer: null,
                    failures: 0,
                    error: null,
                    runRebuild: () => {
                        block.rebuildTimer = null;
                        this.rebuild(block);
                    },
                    runRetry: () => {
                        block.retryTimer = null;
                        this.rebuild(block);
                    },
                };
                this.blocks.push(block);
            }
        }
        this.blockDist = new Float64Array(this.blocks.length);

        this.unsubInSync = source.onInSync(() => this.handleInSync());

        // navigator.onLine is a hint (it can say online without connectivity), but
        // when it says offline it is right, and it reacts faster than the SDK.
        this.browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            const onOnline = () => this.handleNetworkChange(true);
            const onOffline = () => this.handleNetworkChange(false);
            window.addEventListener('online', onOnline);
            window.addEventListener('offline', onOffline);
            this.removeWindowListeners = () => {
                window.removeEventListener('online', onOnline);
                window.removeEventListener('offline', onOffline);
            };
        }
        this.queueStats();
    }

    /**
     * Visible chunk rect (inclusive, may extend past the grid) and view center in
     * pixel coordinates. Cheap when the rect did not change (only the load
     * priority center moves); otherwise O(rows + changed chunks).
     */
    setView(visible: ChunkRect | null, center: { x: number; y: number }): void {
        if (this.disposed) return;
        this.centerX = center.x;
        this.centerY = center.y;
        const next = visible ? this.expand(visible) : null;
        const prev = this.rect;
        if (sameRect(prev, next)) return;
        this.rect = next;
        if (prev) this.diff(prev, next, false);
        if (next) this.diff(next, prev, true);
        this.neededCount = next ? (next.cx1 - next.cx0 + 1) * (next.cy1 - next.cy0 + 1) : 0;
        if (this.lingerMs <= 0) this.evictIfNeeded();
        this.pump();
        this.queueStats();
    }

    /**
     * True when the chunk's content is known up to date: loaded AND covered by a
     * listener whose latest snapshot came from the server since the chunk joined it.
     * Cached chunks outside the listeners keep showing their last known content,
     * which may be outdated: callers must not trust it for decisions.
     */
    isLive(cx: number, cy: number): boolean {
        if (this.disposed || !Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= N || cy >= N) return false;
        const k = chunkKey(cx, cy);
        const block = this.blocks[this.blockOf[k]];
        // Chunks only join a listener when it is created, and snap is reset then, so
        // "latest snapshot is a server one" implies "server snapshot since joining"
        return this.state[k] === LOADED && block.token !== 0 && this.coveredBy[k] === block.token && block.snap === SNAP_SERVER;
    }

    /** Unsubscribes everything and cancels timers; no sink or stats call after this */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const block of this.blocks) {
            if (block.rebuildTimer !== null) clearTimeout(block.rebuildTimer);
            if (block.retryTimer !== null) clearTimeout(block.retryTimer);
            block.rebuildTimer = null;
            block.retryTimer = null;
            this.closeListener(block);
        }
        this.unsubInSync();
        this.removeWindowListeners?.();
        if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
        if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
        this.lingerTimer = null;
        this.pumpTimer = null;
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
        // Running jobs stay suspended on their pending promise and bail out on resume
    }

    // ------------------------------------------------------------------------
    // Needed set, linger, eviction
    // ------------------------------------------------------------------------

    private expand(v: ChunkRect): ChunkRect | null {
        if (!Number.isFinite(v.cx0) || !Number.isFinite(v.cy0) || !Number.isFinite(v.cx1) || !Number.isFinite(v.cy1)) return null;
        const r = this.preloadRing;
        const cx0 = Math.max(0, Math.floor(v.cx0) - r);
        const cy0 = Math.max(0, Math.floor(v.cy0) - r);
        const cx1 = Math.min(N - 1, Math.floor(v.cx1) + r);
        const cy1 = Math.min(N - 1, Math.floor(v.cy1) + r);
        return cx0 > cx1 || cy0 > cy1 ? null : { cx0, cy0, cx1, cy1 };
    }

    /** Visits the chunks of `a` that are not in `b` (row by row, skipping the overlap) */
    private diff(a: ChunkRect, b: ChunkRect | null, entering: boolean): void {
        for (let cy = a.cy0; cy <= a.cy1; cy++) {
            if (b === null || cy < b.cy0 || cy > b.cy1) {
                for (let cx = a.cx0; cx <= a.cx1; cx++) this.toggleNeeded(chunkKey(cx, cy), entering);
            } else {
                const leftEnd = Math.min(a.cx1, b.cx0 - 1);
                for (let cx = a.cx0; cx <= leftEnd; cx++) this.toggleNeeded(chunkKey(cx, cy), entering);
                for (let cx = Math.max(a.cx0, b.cx1 + 1); cx <= a.cx1; cx++) this.toggleNeeded(chunkKey(cx, cy), entering);
            }
        }
    }

    private toggleNeeded(k: number, entering: boolean): void {
        const s = this.state[k];
        const block = this.blocks[this.blockOf[k]];
        if (entering) {
            this.needed[k] = 1;
            if (s !== LOADED) this.neededNotLoaded++;
            if (this.lingering[k]) {
                // Still live: its listener does not change
                this.lingering[k] = 0;
                this.lingerOrder.delete(k);
            } else if (s === LOADED && (block.token === 0 || this.coveredBy[k] !== block.token)) {
                // Cached chunk outside the listener: it rejoins (no reload, `since` covers
                // the absence, see reloadStaleRejoiners for long absences)
                this.markDirty(block);
            }
            return;
        }
        this.needed[k] = 0;
        this.lastNeeded[k] = ++this.lruTick;
        if (s !== LOADED) this.neededNotLoaded--;
        if (s === UNLOADED) return;
        if (this.lingerMs > 0) {
            this.lingering[k] = 1;
            this.lingerDeadline[k] = this.now() + this.lingerMs;
            this.lingerOrder.add(k);
            this.armLinger();
        } else if (s === LOADED) {
            this.closeIfIdle(block);
        }
    }

    private armLinger(): void {
        if (this.lingerTimer !== null || this.disposed) return;
        const first = this.lingerOrder.values().next();
        if (first.done) return;
        this.lingerTimer = setTimeout(this.sweepLinger, Math.max(0, this.lingerDeadline[first.value] - this.now()));
    }

    private readonly sweepLinger = (): void => {
        this.lingerTimer = null;
        if (this.disposed) return;
        const t = this.now();
        for (const k of this.lingerOrder) {
            if (this.lingerDeadline[k] > t) break;
            this.lingerOrder.delete(k);
            this.lingering[k] = 0;
            // A loading chunk just loses its linger (its job aborts at the next page if
            // nothing else needs it); a loaded one stops keeping its listener alive
            if (this.state[k] === LOADED) this.closeIfIdle(this.blocks[this.blockOf[k]]);
        }
        this.armLinger();
        this.evictIfNeeded();
        this.queueStats();
    };

    /** Loaded and needed or lingering: the chunks a block listener exists for */
    private wantsLive(k: number): boolean {
        return this.state[k] === LOADED && (this.needed[k] === 1 || this.lingering[k] === 1);
    }

    /**
     * Shrinking is lazy: a chunk that stops being live stays in its listener (its
     * deltas still arrive, keeping it fresh for free) instead of re-creating the
     * listener, which would re-read the whole `since` window for the block. The
     * listener closes once no chunk of the block is live anymore.
     */
    private closeIfIdle(block: Block): void {
        if (block.token === 0) return;
        for (const k of block.keys) if (this.wantsLive(k)) return;
        this.markDirty(block);
    }

    /** Drops least-recently-needed cached chunks that hold pixels (loaded, neither needed nor lingering) */
    private evictIfNeeded(): void {
        if (this.inkedCount <= this.maxCachedChunks) return;
        const candidates: number[] = [];
        for (let k = 0; k < TOTAL_CHUNKS; k++) {
            if (this.state[k] === LOADED && this.hasInk[k] && !this.needed[k] && !this.lingering[k]) candidates.push(k);
        }
        candidates.sort((a, b) => this.lastNeeded[a] - this.lastNeeded[b]);
        for (const k of candidates) {
            if (this.inkedCount <= this.maxCachedChunks) break;
            this.loadedCount--;
            this.dropChunk(k);
        }
    }

    private markInk(k: number): void {
        if (this.hasInk[k]) return;
        this.hasInk[k] = 1;
        this.inkedCount++;
    }

    private cover(k: number, token: number): void {
        if ((this.coveredBy[k] !== 0) !== (token !== 0)) this.liveCount += token !== 0 ? 1 : -1;
        this.coveredBy[k] = token;
    }

    /** Back to UNLOADED: data dropped from the sink, deltas no longer applied */
    private dropChunk(k: number): void {
        this.state[k] = UNLOADED;
        this.jobOf[k] = null;
        this.cover(k, 0);
        this.syncedAt[k] = 0;
        if (this.hasInk[k]) {
            this.hasInk[k] = 0;
            this.inkedCount--;
        }
        if (this.lingering[k]) {
            this.lingering[k] = 0;
            this.lingerOrder.delete(k);
        }
        this.sink.evict(k % N, Math.floor(k / N));
    }

    // ------------------------------------------------------------------------
    // Loads
    // ------------------------------------------------------------------------

    /** Starts load jobs for needed unloaded chunks, nearest to the center first */
    private pump(): void {
        if (this.disposed || this.rect === null || this.neededNotLoaded === 0) return;
        const capacity = this.maxConcurrentLoads - this.runningJobs;
        if (capacity <= 0) return;

        const t = this.now();
        const dist = this.blockDist;
        dist.fill(Infinity);
        let any = false;
        let nextRetry = Infinity;
        const { cx0, cy0, cx1, cy1 } = this.rect;
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const k = chunkKey(cx, cy);
                if (this.state[k] !== UNLOADED) continue;
                if (this.retryAt[k] > t) {
                    nextRetry = Math.min(nextRetry, this.retryAt[k]);
                    continue;
                }
                const d = this.distanceToCenter(cx, cy);
                const b = this.blockOf[k];
                if (d < dist[b]) dist[b] = d;
                any = true;
            }
        }
        if (nextRetry !== Infinity) this.armPump(nextRetry - t);
        if (!any) return;

        for (let started = 0; started < capacity; started++) {
            let best = -1;
            for (let b = 0; b < dist.length; b++) if (dist[b] !== Infinity && (best < 0 || dist[b] < dist[best])) best = b;
            if (best < 0) break;
            dist[best] = Infinity;
            this.startJob(this.blocks[best], t);
        }
    }

    private distanceToCenter(cx: number, cy: number): number {
        const x0 = cx * CHUNK_SIZE;
        const y0 = cy * CHUNK_SIZE;
        const dx = Math.max(x0 - this.centerX, 0, this.centerX - (x0 + CHUNK_SIZE));
        const dy = Math.max(y0 - this.centerY, 0, this.centerY - (y0 + CHUNK_SIZE));
        return dx * dx + dy * dy;
    }

    private armPump(delay: number): void {
        const due = this.now() + delay;
        if (this.pumpTimer !== null) {
            if (this.pumpDue <= due) return;
            clearTimeout(this.pumpTimer);
        }
        this.pumpDue = due;
        this.pumpTimer = setTimeout(this.runPump, Math.max(0, delay));
    }

    private readonly runPump = (): void => {
        this.pumpTimer = null;
        this.pump();
        this.queueStats();
    };

    /** One job = the eligible needed chunks of one block, in one paginated `in` query */
    private startJob(block: Block, t: number): void {
        const keys: number[] = [];
        for (const k of block.keys) {
            if (this.needed[k] && this.state[k] === UNLOADED && this.retryAt[k] <= t) keys.push(k);
        }
        if (keys.length === 0) return;
        const job: Job = {
            keys,
            ids: keys.map((k) => chunkId(k % N, Math.floor(k / N))),
            startMaxSeen: this.maxSeen,
            startedAt: this.now(),
        };
        for (const k of keys) {
            this.state[k] = LOADING;
            this.jobOf[k] = job;
            this.sink.beginLoad(k % N, Math.floor(k / N));
        }
        this.loadingCount += keys.length;
        this.runningJobs++;
        this.runJob(job).catch((e: unknown) => {
            // Only a throwing sink gets here: give the chunks back so they reload later
            if (this.disposed || job.keys.every((k) => this.jobOf[k] !== job)) return;
            this.loadError = errorMessage(e);
            this.endJob(job, true);
        });
    }

    private async runJob(job: Job): Promise<void> {
        let cursor: PageCursor | null = null;
        let failures = 0;
        for (;;) {
            let page: PixelPage;
            try {
                page = await this.source.fetchPage(job.ids, cursor, this.pageSize);
            } catch (e) {
                if (this.disposed) return;
                failures++;
                this.loadFailStreak++;
                this.loadError = errorMessage(e);
                if (failures >= MAX_PAGE_FAILURES) {
                    this.endJob(job, true);
                    return;
                }
                this.queueStats();
                await this.sleep(this.backoff(failures));
                if (this.disposed) return;
                if (!this.jobStillWanted(job)) {
                    this.endJob(job, false);
                    return;
                }
                continue; // same cursor
            }
            if (this.disposed) return;
            failures = 0;
            this.loadFailStreak = 0;
            this.loadError = null;
            this.applyPage(job, page.docs);
            if (page.next === null) {
                this.finishJob(job);
                return;
            }
            cursor = page.next;
            if (!this.jobStillWanted(job)) {
                // Partial data is useless: drop it, the chunks reload when needed again
                this.endJob(job, false);
                return;
            }
        }
    }

    /** Lingering counts: a quick pan away and back must not restart a big load from scratch */
    private jobStillWanted(job: Job): boolean {
        for (const k of job.keys) if (this.needed[k] || this.lingering[k]) return true;
        return false;
    }

    private applyPage(job: Job, docs: readonly PixelDoc[]): void {
        this.docsRead += docs.length;
        if (docs.length > 0) {
            let max = this.maxSeen;
            let clean = true;
            for (const d of docs) {
                if (d.updatedAtMs > max) max = d.updatedAtMs;
                if (!isInGrid(d.x, d.y)) {
                    clean = false;
                    continue;
                }
                const k = chunkKeyOfPixel(d.x, d.y);
                if (this.jobOf[k] !== job) clean = false;
                else if (d.color !== 0) this.markInk(k);
            }
            this.maxSeen = max;
            // PixelDoc is a PixelUpdate: hand the page over without copying in the common case
            const updates: readonly PixelUpdate[] = clean
                ? docs
                : docs.filter((d) => isInGrid(d.x, d.y) && this.jobOf[chunkKeyOfPixel(d.x, d.y)] === job);
            if (updates.length > 0) this.sink.applyPixels(updates);
        }
        this.queueStats();
    }

    private finishJob(job: Job): void {
        // Lower bound of the server time T1 of the first page (see the header):
        // - startMaxSeen <= server time when the job started <= T1;
        // - every doc received so far has updated_at <= server time at reception, so
        //   maxSeen - (client time elapsed since just before page 1) <= T1, the client
        //   clock offset cancelling out in the difference.
        // The second term is what makes a first load cheap: right after loading a
        // busy chunk it is close to "now", so the listener re-reads only ~safetyMs of
        // writes instead of the whole chunk. (A per-chunk "max updated_at of the
        // pages" is not a lower bound of T1: with a long pagination it could skip
        // writes that landed late during the load.)
        const elapsed = Math.max(0, this.now() - job.startedAt);
        const synced = Math.max(job.startMaxSeen, this.maxSeen - elapsed);
        for (const k of job.keys) {
            this.state[k] = LOADED;
            this.jobOf[k] = null;
            this.syncedAt[k] = synced;
            this.loadFailures[k] = 0;
            this.retryAt[k] = 0;
            this.loadingCount--;
            this.loadedCount++;
            if (this.needed[k]) this.neededNotLoaded--;
            this.sink.finishLoad(k % N, Math.floor(k / N));
        }
        this.runningJobs--;
        // Only now may the chunks join their block listener (they are not covered yet,
        // so the rebuild creates a listener that includes them)
        for (const k of job.keys) {
            if (this.wantsLive(k)) {
                this.markDirty(this.blocks[this.blockOf[k]]);
                break; // a job never spans two blocks
            }
        }
        this.evictIfNeeded();
        this.pump();
        this.queueStats();
    }

    /** Abort (failed = false) or give up after errors (failed = true): chunks back to UNLOADED */
    private endJob(job: Job, failed: boolean): void {
        const t = this.now();
        for (const k of job.keys) {
            if (this.jobOf[k] !== job) continue;
            if (failed) {
                this.loadFailures[k] = Math.min(this.loadFailures[k] + 1, 30);
                this.retryAt[k] = t + this.backoff(this.loadFailures[k]);
            }
            this.loadingCount--;
            this.dropChunk(k);
        }
        this.runningJobs--;
        this.pump();
        this.queueStats();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const id = setTimeout(() => {
                this.timers.delete(id);
                resolve();
            }, ms);
            this.timers.add(id);
        });
    }

    // ------------------------------------------------------------------------
    // Listeners
    // ------------------------------------------------------------------------

    private markDirty(block: Block): void {
        if (this.disposed || block.rebuildTimer !== null || block.retryTimer !== null) return;
        // Not reset by later changes: a rebuild happens at most rebuildDebounceMs after
        // the first change, even during continuous panning
        block.rebuildTimer = setTimeout(block.runRebuild, this.rebuildDebounceMs);
    }

    private rebuild(block: Block): void {
        if (this.disposed) return;
        if (block.token !== 0) this.reloadStaleRejoiners(block);

        const keys: number[] = [];
        let minSynced = Infinity;
        // With no listener every live chunk is uncovered; otherwise look for live
        // chunks the listener does not apply (new loads, rejoins, evicted + reloaded)
        let uncovered = block.token === 0;
        for (const k of block.keys) {
            if (!this.wantsLive(k)) continue;
            keys.push(k);
            if (this.syncedAt[k] < minSynced) minSynced = this.syncedAt[k];
            if (this.coveredBy[k] !== block.token) uncovered = true;
        }
        if (keys.length === 0) {
            this.closeListener(block);
            block.refresh = false;
            block.error = null;
            this.queueStats();
            return;
        }
        if (!uncovered && !block.refresh && block.error === null) {
            // Every live chunk is covered: keep the listener (lazy shrink)
            this.queueStats();
            return;
        }

        // Re-created with exactly the live chunks: the non-live ones kept by the lazy
        // shrink leave now, since the `since` window is re-read anyway
        block.refresh = false;
        this.closeListener(block);
        const token = this.nextToken++;
        block.token = token;
        block.listenKeys = keys;
        block.snap = SNAP_NONE;
        block.everServer = false;
        block.docCount = 0;
        block.initialDocs = 0;
        block.refreshAt = Infinity;
        for (const k of keys) this.cover(k, token);
        this.listenerCount++;

        const ids = keys.map((k) => chunkId(k % N, Math.floor(k / N)));
        try {
            const unsub = this.source.listen(ids, minSynced - this.safetyMs, {
                next: (changes, meta) => this.handleListen(block, token, changes, meta.fromCache),
                error: (e) => this.handleListenError(block, token, e),
            });
            // The listener may already have failed synchronously
            if (block.token === token) block.unsub = unsub;
            else unsub();
        } catch (e) {
            this.handleListenError(block, token, e);
        }
        this.queueStats();
    }

    /**
     * A cached chunk rejoining after a long absence would pull the block's `since`
     * back to its old syncedAt, re-reading every write of the 25 chunks since then.
     * When the chunks already covered are much fresher, reloading that one chunk is
     * the cheaper (bounded) option.
     */
    private reloadStaleRejoiners(block: Block): void {
        let ref = Infinity;
        for (const k of block.listenKeys) {
            if (this.coveredBy[k] === block.token && this.syncedAt[k] < ref) ref = this.syncedAt[k];
        }
        if (ref === Infinity) return;
        const limit = ref - this.rejoinMaxLagMs;
        let reloaded = false;
        for (const k of block.keys) {
            if (this.state[k] !== LOADED || !this.needed[k] || this.coveredBy[k] === block.token || this.syncedAt[k] >= limit) continue;
            this.loadedCount--;
            this.neededNotLoaded++;
            this.dropChunk(k);
            reloaded = true;
        }
        if (reloaded) this.pump();
    }

    private closeListener(block: Block): void {
        if (block.token === 0) return;
        const unsub = block.unsub;
        for (const k of block.listenKeys) if (this.coveredBy[k] === block.token) this.cover(k, 0);
        this.listenerCount--;
        this.listenerDocs -= block.docCount;
        block.token = 0;
        block.unsub = null;
        block.listenKeys = EMPTY_KEYS;
        block.snap = SNAP_NONE;
        block.everServer = false;
        block.docCount = 0;
        unsub?.();
    }

    private handleListen(block: Block, token: number, changes: readonly PixelChange[], fromCache: boolean): void {
        if (this.disposed || block.token !== token) return;
        if (changes.length > 0) {
            this.docsRead += changes.length;
            let max = this.maxSeen;
            let clean = true;
            let sizeDelta = 0;
            for (const c of changes) {
                if (c.updatedAtMs > max) max = c.updatedAtMs;
                if (c.type === 'added') sizeDelta++;
                else if (c.type === 'removed') sizeDelta--;
                if (!isInGrid(c.x, c.y)) {
                    clean = false;
                    continue;
                }
                const k = chunkKeyOfPixel(c.x, c.y);
                // Only chunks this listener covers (not evicted, not reloading meanwhile)
                if (this.coveredBy[k] !== token) clean = false;
                else if (c.type === 'removed') {
                    if (c.color !== 0) clean = false;
                } else if (c.color !== 0) this.markInk(k);
            }
            this.maxSeen = max;
            block.docCount += sizeDelta;
            this.listenerDocs += sizeDelta;
            let updates: readonly PixelUpdate[] = changes;
            if (!clean) {
                const filtered: PixelUpdate[] = [];
                for (const c of changes) {
                    if (!isInGrid(c.x, c.y) || this.coveredBy[chunkKeyOfPixel(c.x, c.y)] !== token) continue;
                    filtered.push({ x: c.x, y: c.y, color: c.type === 'removed' ? 0 : c.color });
                }
                updates = filtered;
            }
            if (updates.length > 0) this.sink.applyPixels(updates);
        }

        if (fromCache) {
            block.snap = SNAP_CACHE;
        } else {
            if (!block.everServer) {
                block.everServer = true;
                block.initialDocs = block.docCount;
                // Refresh threshold relative to the initial result set, so a busy block
                // whose safety window alone is large cannot loop on refreshes
                block.refreshAt = Math.max(this.maxListenerDocs, 2 * block.docCount);
            }
            block.snap = SNAP_SERVER;
            block.failures = 0;
            block.error = null;
            this.wasLive = true;
        }
        if (block.everServer && !block.refresh && block.docCount > block.refreshAt) {
            block.refresh = true;
            this.markDirty(block);
        }
        if (this.listenerDocs > this.maxTotalListenerDocs) this.enforceListenerBudget();
        if (this.inkedCount > this.maxCachedChunks) this.evictIfNeeded();
        this.queueStats();
    }

    /** Refreshes the largest listeners until the summed result sets fit the global budget */
    private enforceListenerBudget(): void {
        // Only listeners that at least doubled since their first server snapshot: a
        // refresh then reclaims at least half of them, so refreshes cannot loop
        const reclaimable = (b: Block) => b.docCount - b.initialDocs;
        let excess = this.listenerDocs - this.maxTotalListenerDocs;
        for (const b of this.blocks) if (b.token !== 0 && b.refresh) excess -= reclaimable(b);
        if (excess <= 0) return;
        const candidates = this.blocks.filter(
            (b) => b.token !== 0 && b.everServer && !b.refresh && b.docCount > 0 && b.docCount >= 2 * b.initialDocs,
        );
        candidates.sort((a, b) => b.docCount - a.docCount);
        for (const b of candidates) {
            if (excess <= 0) break;
            b.refresh = true;
            this.markDirty(b);
            excess -= reclaimable(b);
        }
    }

    private handleListenError(block: Block, token: number, e: unknown): void {
        if (this.disposed || block.token !== token) return;
        this.closeListener(block);
        block.failures++;
        block.error = errorMessage(e);
        if (block.rebuildTimer !== null) {
            clearTimeout(block.rebuildTimer);
            block.rebuildTimer = null;
        }
        // The retry rebuilds from the live set of that moment
        block.retryTimer = setTimeout(block.runRetry, this.backoff(block.failures));
        this.queueStats();
    }

    private handleInSync(): void {
        if (this.disposed) return;
        const seen = this.maxSeen;
        for (const block of this.blocks) {
            // Only listeners currently confirmed by the server; chunks whose coverage
            // started before an eviction/reload are skipped (coveredBy was reset)
            if (block.token === 0 || block.snap !== SNAP_SERVER) continue;
            for (const k of block.listenKeys) {
                if (this.coveredBy[k] === block.token && this.syncedAt[k] < seen) this.syncedAt[k] = seen;
            }
        }
    }

    private handleNetworkChange(online: boolean): void {
        if (this.disposed) return;
        this.browserOffline = !online;
        if (online) {
            // Connectivity is back: retry now instead of waiting for the backoff
            for (const block of this.blocks) {
                if (block.retryTimer === null) continue;
                clearTimeout(block.retryTimer);
                block.retryTimer = null;
                this.rebuild(block);
            }
            this.retryAt.fill(0);
            this.pump();
        }
        this.queueStats();
    }

    private backoff(failures: number): number {
        const raw = Math.min(MAX_BACKOFF_MS, this.retryBaseMs * 2 ** Math.max(0, failures - 1));
        // Jitter in [50%, 100%]: clients that failed together do not retry together
        return raw * (0.5 + 0.5 * Math.random());
    }

    // ------------------------------------------------------------------------
    // Stats
    // ------------------------------------------------------------------------

    private queueStats(): void {
        if (this.statsQueued || this.disposed) return;
        this.statsQueued = true;
        queueMicrotask(() => {
            this.statsQueued = false;
            if (!this.disposed) this.emitStats();
        });
    }

    private emitStats(): void {
        let listenerError: string | null = null;
        for (const block of this.blocks) {
            if (block.error !== null) {
                listenerError = block.error;
                break;
            }
        }
        const error = listenerError ?? this.loadError ?? undefined;
        const s: SyncStats = {
            status: this.computeStatus(listenerError !== null),
            needed: this.neededCount,
            loading: this.loadingCount,
            loaded: this.loadedCount,
            live: this.liveCount,
            listeners: this.listenerCount,
            docsRead: this.docsRead,
        };
        if (error !== undefined) s.error = error;
        const p = this.lastStats;
        if (
            p !== null && p.status === s.status && p.needed === s.needed && p.loading === s.loading && p.loaded === s.loaded &&
            p.live === s.live && p.listeners === s.listeners && p.docsRead === s.docsRead && p.error === s.error
        ) return;
        this.lastStats = s;
        this.onStats(s);
    }

    private computeStatus(listenerError: boolean): SyncStatus {
        if (this.browserOffline) return 'offline';
        if (listenerError) return 'error';
        let pending = false;
        for (const block of this.blocks) {
            // Loaded chunks waiting for their (debounced) listener are not live yet
            if (block.rebuildTimer !== null) pending = true;
            if (block.token === 0) continue;
            // fromCache after a server snapshot = the SDK lost the server. A first
            // snapshot from cache is only pending: the memory cache may hold matching
            // docs (e.g. from the inspector's single-doc listener) before the server answers.
            if (block.snap === SNAP_CACHE && block.everServer) return 'offline';
            if (block.snap !== SNAP_SERVER) pending = true;
        }
        // Loads failing repeatedly (quota, missing index, permissions) while the view
        // still has holes: say so instead of 'connecting'/'live' forever
        if (this.loadError !== null && this.loadFailStreak >= LOAD_ERROR_STATUS_STREAK && this.neededNotLoaded > 0) return 'error';
        // 'connecting' only until the first time everything was in sync: afterwards a
        // freshly rebuilt listener catching up must not flip the status while panning
        if (this.wasLive) return 'live';
        if (pending) return 'connecting';
        if (this.listenerCount === 0 && (this.runningJobs > 0 || this.neededNotLoaded > 0)) return 'connecting';
        return 'live';
    }
}

function defaultClock(): () => number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();
}

function sameRect(a: ChunkRect | null, b: ChunkRect | null): boolean {
    if (a === null || b === null) return a === b;
    return a.cx0 === b.cx0 && a.cy0 === b.cy0 && a.cx1 === b.cx1 && a.cy1 === b.cy1;
}

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message || e.name;
    return String(e);
}
