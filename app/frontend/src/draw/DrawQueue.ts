// Client-side draw queue: one POST /draw per pixel, sent through an adaptive
// concurrency window (AIMD), with retries, backoff and confirmation through the
// Firestore listener (a 202 only means "accepted", the pixel is written later).
import { GRID_SIZE, isInGrid } from '../config';
import { isDrawableColor } from '../palette';
import type { DrawErrorKind, DrawRequest, DrawResult, DrawStats, PendingPixel, PendingState, PixelUpdate } from '../types';
import type { DrawTransport } from './drawClient';

export type DrawQueueErrorKind = DrawErrorKind | 'unconfirmed' | 'queue_full';

export interface DrawQueueHooks {
    /** Client's known color, null if unknown (chunk not loaded) */
    currentColor(x: number, y: number): number | null;
    /** Pending set and/or stats changed; called at most once per microtask */
    onChange(): void;
    /** User-facing, deduplicated (same kind + message at most once per ~5 s) */
    onError(kind: DrawQueueErrorKind, message: string, detail?: string): void;
}

export interface DrawQueueOptions {
    initialConcurrency?: number; // 3
    maxConcurrency?: number;     // 8
    maxAttempts?: number;        // 5 (retryable failures)
    maxQueue?: number;           // 20000 queued pixels
    confirmTimeoutMs?: number;   // 20000: accepted but not seen via the listener
    backoffBaseMs?: number;      // 500, max 15000, jittered
    minIntervalMs?: number;      // 0: optional spacing between request starts (client-side rate limit)
}

const GROWTH_STREAK = 10;            // consecutive successes before +1 concurrency
const BACKOFF_MAX_MS = 15_000;
const RATE_LIMIT_DEFAULT_MS = 10_000;
const RATE_LIMIT_MAX_MS = 120_000;
const ERROR_DEDUP_MS = 5_000;
const SWEEP_GRANULARITY_MS = 250;    // batches confirmation timeouts that expire close together
const UNCONFIRMED_COLLECT_MS = 1_000; // lets a burst of timeouts gather into one message

interface Entry {
    readonly key: number;
    readonly x: number;
    readonly y: number;
    /** queued: color to send / sending, accepted: color sent */
    color: number;
    state: PendingState;
    /** Color to send once the current request is settled (0 = none); only while sending/accepted */
    followUp: number;
    /** Retryable failures so far */
    attempts: number;
    /** Id of the request whose result is still expected (0 = none): stale results are ignored */
    reqId: number;
    /** Confirmation deadline, while accepted */
    deadline: number;
    // Intrusive list links: an entry is in the queue (queued) or the await list (accepted), never both
    prev: Entry | null;
    next: Entry | null;
}

/** Doubly linked list of entries: O(1) push/unshift/remove, FIFO iteration without allocation */
class EntryList {
    head: Entry | null = null;
    tail: Entry | null = null;
    size = 0;

    push(e: Entry): void {
        e.prev = this.tail;
        e.next = null;
        if (this.tail) this.tail.next = e;
        else this.head = e;
        this.tail = e;
        this.size++;
    }

    unshift(e: Entry): void {
        e.prev = null;
        e.next = this.head;
        if (this.head) this.head.prev = e;
        else this.tail = e;
        this.head = e;
        this.size++;
    }

    remove(e: Entry): void {
        if (e.prev) e.prev.next = e.next;
        else this.head = e.next;
        if (e.next) e.next.prev = e.prev;
        else this.tail = e.prev;
        e.prev = e.next = null;
        this.size--;
    }

    clear(): void {
        this.head = this.tail = null;
        this.size = 0;
    }
}

const jitter = (ms: number) => ms / 2 + Math.random() * (ms / 2); // "equal jitter": never 0, spreads clients

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

export class DrawQueue {
    private readonly transport: DrawTransport;
    private readonly hooks: DrawQueueHooks;
    private readonly maxConcurrency: number;
    private readonly maxAttempts: number;
    private readonly maxQueue: number;
    private readonly confirmTimeoutMs: number;
    private readonly backoffBaseMs: number;
    private readonly minIntervalMs: number;

    /** One entry per pixel key, in first-enqueue order */
    private readonly entries = new Map<number, Entry>();
    private readonly queue = new EntryList();
    private readonly awaiting = new EntryList();
    private followUps = 0;
    private sending = 0;

    // Scheduler
    private concurrency: number;
    private active = 0;                       // requests in flight, stale ones included (they hold a slot)
    private readonly controllers = new Map<number, AbortController>();
    private nextReqId = 1;
    private successStreak = 0;
    /** Bumped at each congestion reaction: failures of requests started before it don't react again */
    private epoch = 0;
    private backoffLevel = 0;
    private rateLimitLevel = 0;
    private pauseUntil = 0;
    private lastStartAt = -Infinity;
    /** Set by 401/403: nothing starts until the next enqueue (the app logs the user out) */
    private halted = false;
    private startTimer: ReturnType<typeof setTimeout> | null = null;
    private startTimerAt = Infinity;

    // Confirmation timeouts (one timer for all entries)
    private sweepTimer: ReturnType<typeof setTimeout> | null = null;
    private sweepAt = Infinity;
    private unconfirmedBurst = 0;
    /**
     * Confirmation clocks stop while the listener cannot deliver anything (browser
     * offline, or the runtime reports the sync offline/in error): otherwise every
     * accepted pixel would time out as "never appeared" during a network blip.
     */
    private confirmPausedBySync = false;
    private confirmPausedAt = 0; // Date.now() when the clocks stopped, 0 while running
    private unconfirmedFlushAt = Infinity;
    private lastUnconfirmedEmit = -Infinity;

    // Stats
    private confirmed = 0;
    private failed = 0;
    private unconfirmed = 0;

    private _version = 0;
    private notifyScheduled = false;
    private readonly lastErrors = new Map<string, number>();
    private disposed = false;
    private readonly scratch: PendingPixel = { x: 0, y: 0, color: 0, state: 'queued' };

    constructor(transport: DrawTransport, hooks: DrawQueueHooks, options: DrawQueueOptions = {}) {
        this.transport = transport;
        this.hooks = hooks;
        this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 8));
        this.concurrency = Math.min(this.maxConcurrency, Math.max(1, Math.floor(options.initialConcurrency ?? 3)));
        this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
        this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 20_000));
        this.confirmTimeoutMs = Math.max(0, options.confirmTimeoutMs ?? 20_000);
        this.backoffBaseMs = Math.max(1, options.backoffBaseMs ?? 500);
        this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('online', this.handleOnline);
            window.addEventListener('offline', this.handleOffline);
        }
    }

    // ------------------------------------------------------------------ public

    enqueue(reqs: readonly DrawRequest[]): { queued: number; skipped: number; dropped: number } {
        if (this.disposed) return { queued: 0, skipped: 0, dropped: reqs.length };
        let queued = 0;
        let skipped = 0;
        let dropped = 0;
        let changed = false;

        for (const req of reqs) {
            const { x, y, color } = req;
            if (!isInGrid(x, y) || !isDrawableColor(color)) {
                skipped++;
                continue;
            }
            const key = y * GRID_SIZE + x;
            const e = this.entries.get(key);

            if (!e) {
                if (this.hooks.currentColor(x, y) === color) {
                    skipped++;
                } else if (this.queuedCount() >= this.maxQueue) {
                    dropped++;
                } else {
                    const entry: Entry = {
                        key, x, y, color, state: 'queued', followUp: 0, attempts: 0,
                        reqId: 0, deadline: 0, prev: null, next: null,
                    };
                    this.entries.set(key, entry);
                    this.queue.push(entry);
                    queued++;
                    changed = true;
                }
                continue;
            }

            if (e.state === 'queued') {
                if (e.color === color) {
                    skipped++;
                } else if (this.hooks.currentColor(x, y) === color) {
                    // Nothing was sent yet and the pixel already shows this color: no request at all
                    this.removeEntry(e);
                    queued++;
                    changed = true;
                } else {
                    e.color = color; // replaced in place: keeps its FIFO position
                    queued++;
                    changed = true;
                }
                continue;
            }

            // sending / accepted: at most one follow-up, sent once the current request settles
            if (e.followUp === color || (e.followUp === 0 && e.color === color)) {
                skipped++;
            } else if (e.followUp !== 0) {
                // Back to the color already being written clears the follow-up
                if (color === e.color) {
                    e.followUp = 0;
                    this.followUps--;
                } else {
                    e.followUp = color;
                }
                queued++;
                changed = true;
            } else if (this.queuedCount() >= this.maxQueue) {
                dropped++;
            } else {
                e.followUp = color;
                this.followUps++;
                queued++;
                changed = true;
            }
        }

        // A new user action after a 401/403 (presumably after logging in again) resumes the queue
        if (queued > 0 && this.halted) {
            this.halted = false;
            changed = true;
        }
        if (dropped > 0) {
            this.emitError(
                'queue_full',
                `File d'attente pleine (${this.maxQueue} pixels max) : des pixels ont été ignorés`,
                `${plural(dropped, 'pixel')} ignoré${dropped > 1 ? 's' : ''}`,
            );
        }
        if (changed) this.commit(true);
        this.pump();
        return { queued, skipped, dropped };
    }

    confirm(updates: readonly PixelUpdate[]): void {
        if (this.disposed || this.entries.size === 0) return;
        let changed = false;
        for (const u of updates) {
            if (!isInGrid(u.x, u.y)) continue;
            const e = this.entries.get(u.y * GRID_SIZE + u.x);
            if (!e) continue;
            if (e.state === 'queued') {
                // Nothing in flight and the pixel already has the wanted color: no request needed
                if (u.color === e.color) {
                    this.removeEntry(e);
                    changed = true;
                }
                continue;
            }
            // sending/accepted: the listener may be faster than the 202, so both states confirm.
            // Another color doesn't confirm: someone else may have drawn, our write may still come.
            if (u.color !== e.color) continue;
            this.confirmed++;
            this.settle(e);
            changed = true;
        }
        if (changed) {
            this.commit(true);
            this.pump();
        }
    }

    /** Called by the runtime with the sync status: true while live updates cannot arrive */
    setConfirmationsPaused(paused: boolean): void {
        if (this.disposed || this.confirmPausedBySync === paused) return;
        this.confirmPausedBySync = paused;
        this.updateConfirmPause();
    }

    /** Drops queued (not yet sent) pixels, follow-ups included; returns how many */
    cancelQueued(): number {
        if (this.disposed) return 0;
        let n = 0;
        for (let e = this.queue.head; e; ) {
            const next = e.next;
            this.entries.delete(e.key);
            e = next;
            n++;
        }
        this.queue.clear();
        n += this.dropFollowUps();
        if (n > 0) this.commit(true);
        return n;
    }

    /**
     * One call per pixel with its LATEST intended color. A pending follow-up is
     * reported as 'queued' (that color is not sent yet). The object passed to `cb`
     * is reused between calls: copy its fields to keep them.
     */
    forEachPending(cb: (p: PendingPixel) => void): void {
        const p = this.scratch;
        this.entries.forEach((e) => {
            p.x = e.x;
            p.y = e.y;
            if (e.followUp !== 0) {
                p.color = e.followUp;
                p.state = 'queued';
            } else {
                p.color = e.color;
                p.state = e.state;
            }
            cb(p);
        });
    }

    get pendingCount(): number {
        return this.entries.size;
    }

    /** Increments whenever the pending set (pixels, colors or states) changes */
    get version(): number {
        return this._version;
    }

    stats(): DrawStats {
        return {
            queued: this.queuedCount(),
            inFlight: this.sending,
            awaiting: this.awaiting.size,
            confirmed: this.confirmed,
            failed: this.failed,
            unconfirmed: this.unconfirmed,
            // A halt only matters while something waits; afterwards the next drawing resumes
            paused: (this.halted && this.entries.size > 0) || Date.now() < this.pauseUntil || isOffline(),
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.controllers.forEach((c) => c.abort());
        this.controllers.clear();
        if (this.startTimer) clearTimeout(this.startTimer);
        if (this.sweepTimer) clearTimeout(this.sweepTimer);
        this.startTimer = this.sweepTimer = null;
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('online', this.handleOnline);
            window.removeEventListener('offline', this.handleOffline);
        }
        this.entries.clear();
        this.queue.clear();
        this.awaiting.clear();
        this.followUps = this.sending = 0;
    }

    // --------------------------------------------------------------- scheduler

    private queuedCount(): number {
        return this.queue.size + this.followUps;
    }

    private pump(): void {
        if (this.disposed) return;
        let now = Date.now();
        if (now < this.pauseUntil) {
            // Armed even with an empty queue, so the end of the pause is notified (stats().paused)
            this.armStart(this.pauseUntil, now);
            return;
        }
        if (this.halted || isOffline()) return; // resumed by enqueue() / the 'online' event
        for (let head = this.queue.head; head && this.active < this.concurrency; head = this.queue.head) {
            const at = this.lastStartAt + this.minIntervalMs;
            if (now < at) {
                this.armStart(at, now);
                return;
            }
            this.start(head, now);
            now = Date.now();
        }
    }

    private armStart(at: number, now: number): void {
        if (this.startTimer && this.startTimerAt <= at) return;
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimerAt = at;
        this.startTimer = setTimeout(this.onStartTimer, Math.max(0, at - now));
    }

    private readonly onStartTimer = () => {
        this.startTimer = null;
        this.startTimerAt = Infinity;
        if (this.disposed) return;
        this.commit(false); // the pause may have ended: stats().paused changed
        this.pump();
    };

    private start(e: Entry, now: number): void {
        this.queue.remove(e);
        e.state = 'sending';
        this.sending++;
        const reqId = this.nextReqId++;
        e.reqId = reqId;
        this.active++;
        this.lastStartAt = now;
        const ctrl = new AbortController();
        this.controllers.set(reqId, ctrl);
        const epoch = this.epoch;
        const req: DrawRequest = { x: e.x, y: e.y, color: e.color };
        let pending: Promise<DrawResult>;
        try {
            pending = this.transport.draw(req, ctrl.signal);
        } catch (err) {
            pending = Promise.reject(err);
        }
        pending.then(
            (res) => this.onResult(e, reqId, epoch, res),
            (err: unknown) => this.onResult(e, reqId, epoch, {
                ok: false, kind: 'network', status: 0, message: err instanceof Error ? err.message : String(err),
            }),
        );
        this.commit(true);
    }

    private onResult(e: Entry, reqId: number, epoch: number, res: DrawResult): void {
        if (this.disposed) return;
        this.active--;
        this.controllers.delete(reqId);
        const now = Date.now();
        // Stale: confirmed by the listener before the response, or superseded since
        const current = e.reqId === reqId && e.state === 'sending' && this.entries.get(e.key) === e;
        if (current) {
            e.reqId = 0;
            this.sending--;
        }

        if (res.ok) {
            // Server health signals apply even to stale responses
            this.backoffLevel = 0;
            this.rateLimitLevel = 0;
            // Only grow while there is a backlog: successes at low load say nothing about the limit
            if (this.queue.size > 0 && ++this.successStreak >= GROWTH_STREAK) {
                this.successStreak = 0;
                if (this.concurrency < this.maxConcurrency) this.concurrency++;
            }
            if (current) {
                e.state = 'accepted';
                e.deadline = now + this.confirmTimeoutMs;
                this.awaiting.push(e);
                this.armSweep(now);
            }
        } else {
            this.successStreak = 0;
            this.handleFailure(current ? e : null, epoch, res, now);
        }
        // A stale failure can still change the pending set (401/403 drop everything queued)
        this.commit(current || !res.ok);
        this.pump();
    }

    private handleFailure(e: Entry | null, epoch: number, res: Extract<DrawResult, { ok: false }>, now: number): void {
        const { kind, message } = res;
        const detail = res.correlationId ? `correlation id : ${res.correlationId}` : undefined;
        // 423 is how a future backend may reject draws while the canvas is paused; 404/405/415
        // mean a misrouted or misconfigured gateway. All are global, like 401/403: sending the
        // rest of the queue would fail the same way.
        const global = kind === 'unauthorized' || kind === 'forbidden' ||
            res.status === 423 || res.status === 404 || res.status === 405 || res.status === 415;

        if (global) {
            const dropped = this.dropAllQueued();
            this.failed += dropped;
            if (e) {
                this.failed++;
                this.settle(e);
            }
            if (!this.halted) {
                this.halted = true;
                this.emitError(kind, message, detail);
            }
            return;
        }

        // While halted every queued pixel was dropped: in-flight ones that fail follow them silently
        if (this.halted) {
            if (e) {
                this.failed++;
                this.settle(e);
            }
            return;
        }

        if (kind === 'rate_limited') {
            if (epoch === this.epoch) {
                this.epoch++;
                this.rateLimitLevel++;
                const wait = res.retryAfterMs ?? Math.min(RATE_LIMIT_DEFAULT_MS * 2 ** (this.rateLimitLevel - 1), RATE_LIMIT_MAX_MS);
                this.pauseUntil = Math.max(this.pauseUntil, now + wait);
                this.concurrency = 1;
                this.emitError(kind, message, detail);
            }
            // Not the pixel's fault: retried without consuming an attempt
            if (e) this.requeueFront(e);
            return;
        }

        if (kind === 'unavailable' || kind === 'network') {
            // Offline: the 'online' event resumes the queue, the pixel keeps its attempts
            if (kind === 'network' && isOffline()) {
                if (e) this.requeueFront(e);
                return;
            }
            if (epoch === this.epoch) {
                // React once per congestion episode: requests already in flight at the time of
                // the reaction would otherwise halve the window again for the same overload
                this.epoch++;
                this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
                const delay = jitter(Math.min(this.backoffBaseMs * 2 ** this.backoffLevel, BACKOFF_MAX_MS));
                this.backoffLevel++;
                this.pauseUntil = Math.max(this.pauseUntil, now + delay);
            }
            if (!e) return;
            e.attempts++;
            if (e.attempts >= this.maxAttempts) {
                this.failed++;
                this.settle(e);
                this.emitError(kind, message, detail);
            } else {
                this.requeueFront(e);
            }
            return;
        }

        // bad_request / unknown: this pixel only, not retried
        if (e) {
            this.failed++;
            this.settle(e);
        }
        this.emitError(kind, message, detail);
    }

    private requeueFront(e: Entry): void {
        if (e.followUp !== 0) {
            // The failed color may or may not be written: sending the newer one is right either way
            e.color = e.followUp;
            e.followUp = 0;
            this.followUps--;
        }
        e.state = 'queued';
        this.queue.unshift(e);
    }

    /**
     * The entry's current request is over (confirmed, failed, timed out): its follow-up,
     * if any, takes the next slot; otherwise the pixel leaves the pending set.
     * Expects the entry out of the queue; removes it from the await list if needed.
     */
    private settle(e: Entry): void {
        if (e.state === 'accepted') this.awaiting.remove(e);
        else if (e.state === 'sending' && e.reqId !== 0) {
            this.sending--;
            e.reqId = 0; // its response, if it ever comes, is now stale
        }
        if (e.followUp !== 0) {
            e.color = e.followUp;
            e.followUp = 0;
            this.followUps--;
            e.attempts = 0;
            e.state = 'queued';
            this.queue.unshift(e);
        } else {
            this.entries.delete(e.key);
        }
    }

    private removeEntry(e: Entry): void {
        if (e.state === 'queued') this.queue.remove(e);
        this.entries.delete(e.key);
    }

    private dropAllQueued(): number {
        let n = this.queue.size;
        for (let e = this.queue.head; e; e = e.next) this.entries.delete(e.key);
        this.queue.clear();
        n += this.dropFollowUps();
        return n;
    }

    private dropFollowUps(): number {
        if (this.followUps === 0) return 0;
        let n = 0;
        this.entries.forEach((e) => {
            if (e.followUp !== 0) {
                e.followUp = 0;
                n++;
            }
        });
        this.followUps = 0;
        return n;
    }

    // ------------------------------------------------------ confirmation timer

    private armSweep(now: number): void {
        if (this.confirmPausedAt !== 0) return; // re-armed when the clocks restart
        const head = this.awaiting.head;
        const wake = Math.min(head ? head.deadline + SWEEP_GRANULARITY_MS : Infinity, this.unconfirmedFlushAt);
        if (wake === Infinity) {
            if (this.sweepTimer) clearTimeout(this.sweepTimer);
            this.sweepTimer = null;
            this.sweepAt = Infinity;
            return;
        }
        if (this.sweepTimer && this.sweepAt <= wake) return;
        if (this.sweepTimer) clearTimeout(this.sweepTimer);
        this.sweepAt = wake;
        this.sweepTimer = setTimeout(this.sweep, Math.max(0, wake - now));
    }

    private readonly sweep = () => {
        this.sweepTimer = null;
        this.sweepAt = Infinity;
        if (this.disposed || this.confirmPausedAt !== 0) return;
        const now = Date.now();
        let expired = 0;
        // Deadlines are in acceptance order (constant timeout), so the head expires first
        for (let e = this.awaiting.head; e && e.deadline <= now; e = this.awaiting.head) {
            this.unconfirmed++;
            expired++;
            this.settle(e);
        }
        if (expired > 0) {
            this.unconfirmedBurst += expired;
            if (this.unconfirmedFlushAt === Infinity) {
                this.unconfirmedFlushAt = Math.max(now + UNCONFIRMED_COLLECT_MS, this.lastUnconfirmedEmit + ERROR_DEDUP_MS);
            }
        }
        if (this.unconfirmedBurst > 0 && now >= this.unconfirmedFlushAt) {
            const n = this.unconfirmedBurst;
            this.unconfirmedBurst = 0;
            this.unconfirmedFlushAt = Infinity;
            this.lastUnconfirmedEmit = now;
            // Aggregated and throttled here, so it bypasses the generic dedup (the count changes)
            this.hooks.onError(
                'unconfirmed',
                `${plural(n, 'pixel')} accepté${n > 1 ? 's' : ''} mais jamais apparu${n > 1 ? 's' : ''} sur la toile`,
                `Délai de ${Math.round(this.confirmTimeoutMs / 1000)} s dépassé : recouvert par un autre joueur ou synchronisation en retard.`,
            );
        }
        this.armSweep(now);
        if (expired > 0) {
            this.commit(true);
            this.pump();
        }
    };

    // ------------------------------------------------------------ online state

    private readonly handleOnline = () => {
        if (this.disposed) return;
        this.updateConfirmPause();
        this.commit(false);
        this.pump();
    };

    private readonly handleOffline = () => {
        if (this.disposed) return;
        this.updateConfirmPause();
        this.commit(false);
    };

    private updateConfirmPause(): void {
        const paused = this.confirmPausedBySync || isOffline();
        const now = Date.now();
        if (paused && this.confirmPausedAt === 0) {
            this.confirmPausedAt = now;
            if (this.sweepTimer) clearTimeout(this.sweepTimer);
            this.sweepTimer = null;
            this.sweepAt = Infinity;
        } else if (!paused && this.confirmPausedAt !== 0) {
            // Shift every deadline by the paused time: order (and the head-first sweep) is preserved
            const elapsed = now - this.confirmPausedAt;
            this.confirmPausedAt = 0;
            for (let e = this.awaiting.head; e; e = e.next) e.deadline += elapsed;
            this.armSweep(now);
        }
    }

    // ------------------------------------------------------------ notification

    /** Ends a mutation: bumps the version if the pending set changed, schedules onChange */
    private commit(pendingChanged: boolean): void {
        if (pendingChanged) this._version++;
        if (this.notifyScheduled || this.disposed) return;
        this.notifyScheduled = true;
        queueMicrotask(() => {
            this.notifyScheduled = false;
            if (!this.disposed) this.hooks.onChange();
        });
    }

    private emitError(kind: DrawQueueErrorKind, message: string, detail?: string): void {
        if (this.disposed) return;
        const now = Date.now();
        const id = `${kind}\u0000${message}`;
        const last = this.lastErrors.get(id);
        if (last !== undefined && now - last < ERROR_DEDUP_MS) return;
        if (this.lastErrors.size > 64) {
            this.lastErrors.forEach((t, k) => {
                if (now - t >= ERROR_DEDUP_MS) this.lastErrors.delete(k);
            });
        }
        this.lastErrors.set(id, now);
        this.hooks.onError(kind, message, detail);
    }
}
