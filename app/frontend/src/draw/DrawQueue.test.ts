import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRID_SIZE } from '../config';
import type { DrawErrorKind, DrawRequest, DrawResult, PendingPixel } from '../types';
import { DrawQueue, type DrawQueueOptions } from './DrawQueue';
import type { DrawTransport } from './drawClient';

interface Call {
    req: DrawRequest;
    signal?: AbortSignal;
    resolve: (r: DrawResult) => void;
    settled: boolean;
}

/** Transport whose responses are resolved by the test */
class FakeTransport implements DrawTransport {
    readonly calls: Call[] = [];
    maxOpen = 0;

    draw(req: DrawRequest, signal?: AbortSignal): Promise<DrawResult> {
        return new Promise((resolve) => {
            const call: Call = {
                req, signal, settled: false,
                resolve: (r) => {
                    call.settled = true;
                    resolve(r);
                },
            };
            this.calls.push(call);
            this.maxOpen = Math.max(this.maxOpen, this.open.length);
        });
    }

    get open(): Call[] {
        return this.calls.filter((c) => !c.settled);
    }

    /** Resolves the oldest open call */
    next(result: DrawResult): Call {
        const c = this.open[0];
        if (!c) throw new Error('no open call');
        c.resolve(result);
        return c;
    }

    sent(): string[] {
        return this.calls.map((c) => `${c.req.x},${c.req.y}:${c.req.color}`);
    }
}

const OK: DrawResult = { ok: true, eventId: 'ev', correlationId: 'cid' };
const err = (kind: DrawErrorKind, status: number, message = `err ${status}`, retryAfterMs?: number): DrawResult =>
    ({ ok: false, kind, status, message, correlationId: 'cid-x', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
const E503 = err('unavailable', 503, 'file indisponible');

const px = (x: number, y = 0, color = 4): DrawRequest => ({ x, y, color });
const range = (n: number, color = 4) => Array.from({ length: n }, (_, i) => px(i, 0, color));

/** Lets promise callbacks and microtasks run (fake timers do not advance) */
const flush = () => vi.advanceTimersByTimeAsync(0);

let transport: FakeTransport;
let known: Map<number, number>;
let hooks: { currentColor: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> };
let queue: DrawQueue | null = null;

function make(options: DrawQueueOptions = {}): DrawQueue {
    queue = new DrawQueue(transport, hooks as never, { backoffBaseMs: 500, ...options });
    return queue;
}

function pending(q: DrawQueue): PendingPixel[] {
    const out: PendingPixel[] = [];
    q.forEachPending((p) => out.push({ ...p }));
    return out;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1); // jitter(ms) = ms: deterministic backoff
    transport = new FakeTransport();
    known = new Map();
    hooks = {
        currentColor: vi.fn((x: number, y: number) => known.get(y * GRID_SIZE + x) ?? null),
        onChange: vi.fn(),
        onError: vi.fn(),
    };
});

afterEach(() => {
    queue?.dispose();
    queue = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('enqueue', () => {
    it('validates pixels and colors', () => {
        const q = make();
        const r = q.enqueue([px(-1), px(GRID_SIZE), px(1.5), px(0, 0, 0), px(0, 0, 999), px(0, 0, 2.5), px(3, 3, 16)]);
        expect(r).toEqual({ queued: 1, skipped: 6, dropped: 0 });
        expect(transport.sent()).toEqual(['3,3:16']);
    });

    it('deduplicates within a batch: same color skipped, other color replaces in place', () => {
        const q = make({ initialConcurrency: 1 });
        const r = q.enqueue([px(1, 0, 4), px(1, 0, 4), px(2, 0, 4), px(1, 0, 6)]);
        expect(r).toEqual({ queued: 3, skipped: 1, dropped: 0 });
        expect(q.pendingCount).toBe(2);
        expect(transport.sent()).toEqual(['1,0:6']); // latest color, first position
    });

    it('replaces a queued color in place, keeping its FIFO position', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(0), px(1), px(2)]);
        q.enqueue([px(1, 0, 9)]);
        for (let i = 0; i < 3; i++) {
            transport.next(OK);
            await flush();
        }
        expect(transport.sent()).toEqual(['0,0:4', '1,0:9', '2,0:4']);
    });

    it('keeps one follow-up per in-flight pixel and sends it after the confirmation', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(5, 5, 4)]);
        expect(q.enqueue([px(5, 5, 4)])).toEqual({ queued: 0, skipped: 1, dropped: 0 });
        expect(q.enqueue([px(5, 5, 6)])).toEqual({ queued: 1, skipped: 0, dropped: 0 });
        expect(q.enqueue([px(5, 5, 7)])).toEqual({ queued: 1, skipped: 0, dropped: 0 });
        expect(q.enqueue([px(5, 5, 7)])).toEqual({ queued: 0, skipped: 1, dropped: 0 });
        expect(q.pendingCount).toBe(1);
        expect(q.stats()).toMatchObject({ queued: 1, inFlight: 1 });
        expect(pending(q)).toEqual([{ x: 5, y: 5, color: 7, state: 'queued' }]);

        transport.next(OK);
        await flush();
        expect(q.stats()).toMatchObject({ queued: 1, inFlight: 0, awaiting: 1 });
        expect(transport.calls).toHaveLength(1); // the follow-up waits for the listener: writes may be reordered

        q.confirm([{ x: 5, y: 5, color: 4 }]);
        expect(q.stats()).toMatchObject({ confirmed: 1, queued: 0, inFlight: 1 });
        expect(transport.sent()).toEqual(['5,5:4', '5,5:7']);
        expect(pending(q)).toEqual([{ x: 5, y: 5, color: 7, state: 'sending' }]);
    });

    it('drops the follow-up when the latest intent equals the color in flight', () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(5, 5, 4)]);
        q.enqueue([px(5, 5, 6)]);
        expect(q.stats().queued).toBe(1);
        q.enqueue([px(5, 5, 4)]);
        expect(q.stats().queued).toBe(0);
        expect(pending(q)).toEqual([{ x: 5, y: 5, color: 4, state: 'sending' }]);
    });

    it('skips no-ops only when nothing is pending for the pixel', () => {
        known.set(0, 4); // pixel (0,0) already black
        const q = make({ initialConcurrency: 1 });
        expect(q.enqueue([px(0, 0, 4)])).toEqual({ queued: 0, skipped: 1, dropped: 0 });
        expect(transport.calls).toHaveLength(0);

        q.enqueue([px(0, 0, 6)]);              // in flight: red
        expect(q.enqueue([px(0, 0, 4)])).toEqual({ queued: 1, skipped: 0, dropped: 0 }); // follow-up back to black
        expect(q.stats().queued).toBe(1);
    });

    it('removes a queued entry when the new intent matches the current color', () => {
        known.set(1, 4);
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(0), px(1, 0, 6)]);       // (1,0) red queued behind (0,0)
        q.enqueue([px(1, 0, 4)]);              // back to its current color: nothing to send
        expect(q.pendingCount).toBe(1);
    });

    it('drops pixels beyond maxQueue and reports it once', () => {
        const q = make({ initialConcurrency: 1, maxQueue: 5 });
        expect(q.enqueue(range(10))).toEqual({ queued: 5, skipped: 0, dropped: 5 });
        expect(q.enqueue([px(50), px(51)])).toEqual({ queued: 1, skipped: 0, dropped: 1 }); // one slot freed by the start
        const full = hooks.onError.mock.calls.filter((c) => c[0] === 'queue_full');
        expect(full).toHaveLength(1);
        expect(full[0][2]).toMatch(/5 pixels/);
    });
});

describe('scheduler', () => {
    it('respects the concurrency window', async () => {
        const q = make({ initialConcurrency: 3 });
        q.enqueue(range(10));
        expect(transport.open).toHaveLength(3);
        expect(q.stats()).toMatchObject({ queued: 7, inFlight: 3 });
        transport.next(OK);
        await flush();
        expect(transport.open).toHaveLength(3);
        expect(transport.calls).toHaveLength(4);
        expect(transport.maxOpen).toBe(3);
    });

    it('sends in FIFO order', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(3), px(1)]);
        q.enqueue([px(2)]);
        for (let i = 0; i < 3; i++) {
            transport.next(OK);
            await flush();
        }
        expect(transport.sent()).toEqual(['3,0:4', '1,0:4', '2,0:4']);
        expect(q.stats()).toMatchObject({ awaiting: 3, queued: 0 });
    });

    it('grows the window by one every 10 successes while there is a backlog, up to max', async () => {
        const q = make({ initialConcurrency: 2, maxConcurrency: 4 });
        q.enqueue(range(100));
        for (let i = 0; i < 9; i++) {
            transport.next(OK);
            await flush();
        }
        expect(transport.open).toHaveLength(2);
        transport.next(OK);
        await flush();
        expect(transport.open).toHaveLength(3);
        for (let i = 0; i < 10; i++) {
            transport.next(OK);
            await flush();
        }
        expect(transport.open).toHaveLength(4);
        for (let i = 0; i < 30; i++) {
            transport.next(OK);
            await flush();
        }
        expect(transport.open).toHaveLength(4);
        expect(transport.maxOpen).toBe(4);
    });

    it('halves the window once per congestion episode and backs off', async () => {
        const q = make({ initialConcurrency: 8 });
        q.enqueue(range(30));
        expect(transport.open).toHaveLength(8);
        transport.next(E503);                 // 8 -> 4, pause 500 ms
        await flush();
        for (let i = 0; i < 3; i++) transport.next(E503); // same episode: no further halving
        await flush();
        for (let i = 0; i < 4; i++) transport.next(OK);
        await flush();
        expect(transport.open).toHaveLength(0);
        expect(q.stats().paused).toBe(true);
        await vi.advanceTimersByTimeAsync(499);
        expect(transport.open).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.open).toHaveLength(4);
        expect(q.stats().paused).toBe(false);
        // The failed pixels are retried first
        expect(transport.open.map((c) => c.req.x).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
        expect(q.stats().failed).toBe(0);
    });

    it('never goes below one request', async () => {
        const q = make({ initialConcurrency: 1, maxAttempts: 10 });
        q.enqueue(range(3));
        transport.next(E503);
        await vi.advanceTimersByTimeAsync(500);
        expect(transport.open).toHaveLength(1);
        transport.next(E503);
        await vi.advanceTimersByTimeAsync(1000);
        expect(transport.open).toHaveLength(1);
    });

    it('retries a 503 with exponential backoff, then succeeds', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(7)]);
        transport.next(E503);
        await flush();
        expect(q.stats()).toMatchObject({ queued: 1, inFlight: 0, paused: true });
        expect(pending(q)[0].state).toBe('queued');
        await vi.advanceTimersByTimeAsync(499);
        expect(transport.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.calls).toHaveLength(2);
        transport.next(err('network', 0, 'Réseau indisponible'));
        await vi.advanceTimersByTimeAsync(999);
        expect(transport.calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.calls).toHaveLength(3);
        transport.next(OK);
        await flush();
        expect(q.stats()).toMatchObject({ awaiting: 1, failed: 0, paused: false });
        expect(transport.sent()).toEqual(['7,0:4', '7,0:4', '7,0:4']);
        expect(hooks.onError).not.toHaveBeenCalled();
    });

    it('caps the backoff at 15 s', async () => {
        const q = make({ initialConcurrency: 1, maxAttempts: 100 });
        q.enqueue([px(7)]);
        for (let i = 0; i < 8; i++) {
            transport.next(E503);
            await vi.advanceTimersByTimeAsync(15_000);
        }
        expect(transport.calls).toHaveLength(9);
        transport.next(E503);
        await vi.advanceTimersByTimeAsync(14_999);
        expect(transport.calls).toHaveLength(9);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.calls).toHaveLength(10);
    });

    it('fails a pixel after maxAttempts retryable failures', async () => {
        const q = make({ initialConcurrency: 1, maxAttempts: 3 });
        q.enqueue([px(7), px(8)]);
        for (let i = 0; i < 3; i++) {
            expect(transport.open[0].req.x).toBe(7);
            transport.next(E503);
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(q.stats().failed).toBe(1);
        expect(hooks.onError).toHaveBeenCalledTimes(1);
        expect(hooks.onError).toHaveBeenCalledWith('unavailable', 'file indisponible', 'correlation id : cid-x');
        expect(transport.open[0].req.x).toBe(8);
        expect(q.pendingCount).toBe(1);
    });

    it('drops a pixel on 400 and reports the server message, deduplicated', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue(range(4));
        transport.next(err('bad_request', 400, 'couleur invalide'));
        await flush();
        transport.next(err('bad_request', 400, 'couleur invalide'));
        await flush();
        expect(q.stats()).toMatchObject({ failed: 2, paused: false });
        expect(hooks.onError).toHaveBeenCalledTimes(1);
        expect(hooks.onError).toHaveBeenCalledWith('bad_request', 'couleur invalide', 'correlation id : cid-x');
        await vi.advanceTimersByTimeAsync(5000);
        transport.next(err('bad_request', 400, 'couleur invalide'));
        await flush();
        expect(hooks.onError).toHaveBeenCalledTimes(2);
        expect(transport.open).toHaveLength(1); // the queue keeps going
    });

    it('treats unknown 4xx as non-retryable', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue(range(2));
        transport.next(err('unknown', 409, 'conflit (HTTP 409)'));
        await flush();
        expect(q.stats().failed).toBe(1);
        expect(hooks.onError).toHaveBeenCalledWith('unknown', 'conflit (HTTP 409)', 'correlation id : cid-x');
        expect(transport.sent()).toEqual(['0,0:4', '1,0:4']);
    });

    it('drops everything queued on 401 and reports it once', async () => {
        const q = make({ initialConcurrency: 2 });
        q.enqueue(range(10));
        q.enqueue([px(0, 0, 6)]);             // follow-up on an in-flight pixel
        transport.next(err('unauthorized', 401, 'jeton invalide'));
        await flush();
        expect(q.stats()).toMatchObject({ queued: 0, inFlight: 1, failed: 10, paused: true });
        transport.next(err('unauthorized', 401, 'jeton invalide'));
        await flush();
        expect(q.stats()).toMatchObject({ failed: 11, inFlight: 0 });
        expect(q.pendingCount).toBe(0);
        expect(hooks.onError).toHaveBeenCalledTimes(1);
        expect(hooks.onError).toHaveBeenCalledWith('unauthorized', 'jeton invalide', 'correlation id : cid-x');
        expect(transport.calls).toHaveLength(2);

        // Drawing again (after logging in) resumes the queue
        q.enqueue([px(42)]);
        expect(q.stats().paused).toBe(false);
        expect(transport.calls).toHaveLength(3);
    });

    it('a stale 401 (pixel already confirmed) still drops the queue and bumps the version', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue(range(3));
        q.confirm([{ x: 0, y: 0, color: 4 }]);
        const v = q.version;
        transport.next(err('unauthorized', 401, 'jeton invalide'));
        await flush();
        expect(q.version).toBeGreaterThan(v);
        expect(q.pendingCount).toBe(0);
        expect(q.stats()).toMatchObject({ confirmed: 1, failed: 2, paused: false });
    });

    it('drops everything queued on 403 with kind forbidden', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue(range(5));
        transport.next(err('forbidden', 403, 'PERMISSION_DENIED'));
        await flush();
        expect(q.stats()).toMatchObject({ queued: 0, failed: 5, paused: false });
        expect(hooks.onError).toHaveBeenCalledWith('forbidden', 'PERMISSION_DENIED', 'correlation id : cid-x');
    });

    it('pauses on 429 for retryAfterMs (or 10 s, doubling), then ramps up from 1', async () => {
        // Long confirmation timeout: this test runs 30+ s of fake time without confirming
        const q = make({ initialConcurrency: 3, maxConcurrency: 8, confirmTimeoutMs: 600_000 });
        q.enqueue(range(50));
        transport.next(err('rate_limited', 429, 'trop de pixels', 2000));
        await flush();
        transport.next(OK);
        transport.next(OK);
        await flush();
        expect(q.stats().paused).toBe(true);
        await vi.advanceTimersByTimeAsync(1999);
        expect(transport.calls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.open).toHaveLength(1);      // concurrency 1 after a 429
        expect(transport.open[0].req.x).toBe(0);     // requeued at the front, no attempt consumed

        transport.next(err('rate_limited', 429, 'trop de pixels'));
        await vi.advanceTimersByTimeAsync(9_999);
        expect(transport.open).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        transport.next(err('rate_limited', 429, 'trop de pixels'));
        await vi.advanceTimersByTimeAsync(19_999);   // repeated 429 without success: 20 s
        expect(transport.open).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.open).toHaveLength(1);
        for (let i = 0; i < 10; i++) {
            transport.next(OK);
            await flush();
        }
        expect(transport.open).toHaveLength(2);      // additive increase again
        expect(q.stats().failed).toBe(0);
        expect(hooks.onError.mock.calls.every((c) => c[0] === 'rate_limited')).toBe(true);
    });

    it('spaces request starts by minIntervalMs', async () => {
        const q = make({ initialConcurrency: 5, minIntervalMs: 100 });
        q.enqueue(range(5));
        expect(transport.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(99);
        expect(transport.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(300);
        expect(transport.calls).toHaveLength(5);
    });

    it('pauses while offline and resumes on the online event', async () => {
        const nav = { onLine: false };
        const win = new EventTarget();
        vi.stubGlobal('navigator', nav);
        vi.stubGlobal('window', win);
        const q = make();
        q.enqueue(range(3));
        expect(transport.calls).toHaveLength(0);
        expect(q.stats().paused).toBe(true);
        nav.onLine = true;
        win.dispatchEvent(new Event('online'));
        expect(transport.calls).toHaveLength(3);
        expect(q.stats().paused).toBe(false);

        // A network failure while offline is retried without consuming an attempt
        nav.onLine = false;
        transport.next(err('network', 0, 'Réseau indisponible'));
        await flush();
        expect(q.stats()).toMatchObject({ queued: 1, failed: 0, paused: true });
        q.dispose();
        nav.onLine = true;
        win.dispatchEvent(new Event('online'));
        expect(transport.calls).toHaveLength(3); // listener removed by dispose
    });
});

describe('confirm', () => {
    it('confirms an in-flight pixel before its 202 arrives', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(1), px(2)]);
        q.confirm([{ x: 1, y: 0, color: 4 }]);
        expect(q.stats()).toMatchObject({ confirmed: 1, inFlight: 0, awaiting: 0 });
        expect(q.pendingCount).toBe(1);
        expect(transport.calls).toHaveLength(1);    // the slot is held until the response
        transport.next(OK);
        await flush();
        expect(q.stats()).toMatchObject({ confirmed: 1, awaiting: 0, inFlight: 1 });
        expect(transport.sent()).toEqual(['1,0:4', '2,0:4']);
    });

    it('confirms an accepted pixel', async () => {
        const q = make();
        q.enqueue([px(1)]);
        transport.next(OK);
        await flush();
        expect(pending(q)).toEqual([{ x: 1, y: 0, color: 4, state: 'accepted' }]);
        q.confirm([{ x: 1, y: 0, color: 4 }, { x: 99, y: 99, color: 4 }]);
        expect(q.stats()).toMatchObject({ confirmed: 1, awaiting: 0 });
        expect(q.pendingCount).toBe(0);
    });

    it('does not confirm another color', async () => {
        const q = make();
        q.enqueue([px(1)]);
        transport.next(OK);
        await flush();
        q.confirm([{ x: 1, y: 0, color: 6 }]);
        expect(q.stats()).toMatchObject({ confirmed: 0, awaiting: 1 });
    });

    it('drops a queued pixel that already has the wanted color', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue([px(1), px(2)]);
        q.confirm([{ x: 2, y: 0, color: 4 }]);
        expect(q.stats()).toMatchObject({ queued: 0, confirmed: 0 });
        transport.next(OK);
        await flush();
        expect(transport.sent()).toEqual(['1,0:4']);
    });

    it('turns accepted pixels never seen into one aggregated unconfirmed error', async () => {
        const q = make({ initialConcurrency: 5, confirmTimeoutMs: 1000 });
        q.enqueue(range(5));
        transport.next(OK);
        transport.next(OK);
        await vi.advanceTimersByTimeAsync(200);
        transport.next(OK);
        transport.next(OK);
        transport.next(OK);
        await flush();
        q.confirm([{ x: 4, y: 0, color: 4 }]);
        expect(q.stats().awaiting).toBe(4);
        await vi.advanceTimersByTimeAsync(990);
        expect(q.stats().unconfirmed).toBe(0);
        await vi.advanceTimersByTimeAsync(3000);
        expect(q.stats()).toMatchObject({ unconfirmed: 4, awaiting: 0, confirmed: 1 });
        expect(q.pendingCount).toBe(0);
        const calls = hooks.onError.mock.calls.filter((c) => c[0] === 'unconfirmed');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toMatch(/^4 pixels/);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('sends the follow-up when the confirmation times out', async () => {
        const q = make({ initialConcurrency: 1, confirmTimeoutMs: 1000 });
        q.enqueue([px(1)]);
        transport.next(OK);
        await flush();
        q.enqueue([px(1, 0, 6)]);
        await vi.advanceTimersByTimeAsync(1300);
        expect(q.stats().unconfirmed).toBe(1);
        expect(transport.sent()).toEqual(['1,0:4', '1,0:6']);
    });
});

describe('review fixes', () => {
    it('stops the confirmation clocks while the sync is down, then shifts the deadlines', async () => {
        const q = make({ confirmTimeoutMs: 20_000 });
        q.enqueue([px(1)]);
        transport.next(OK);
        await flush();
        expect(q.stats().awaiting).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        q.setConfirmationsPaused(true);
        // A long outage: nothing expires while paused
        await vi.advanceTimersByTimeAsync(60_000);
        expect(q.stats()).toMatchObject({ awaiting: 1, unconfirmed: 0 });
        q.setConfirmationsPaused(false);
        // 10 s were left on the clock
        await vi.advanceTimersByTimeAsync(9_000);
        expect(q.stats().awaiting).toBe(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(q.stats()).toMatchObject({ awaiting: 0, unconfirmed: 1 });
    });

    it('a confirmation that arrives after a pause still confirms', async () => {
        const q = make();
        q.enqueue([px(2)]);
        transport.next(OK);
        await flush();
        q.setConfirmationsPaused(true);
        await vi.advanceTimersByTimeAsync(40_000);
        q.setConfirmationsPaused(false);
        q.confirm([{ x: 2, y: 0, color: 4 }]);
        await flush();
        expect(q.stats()).toMatchObject({ awaiting: 0, confirmed: 1, unconfirmed: 0 });
    });

    it('treats 404 as a global stop: the rest of the queue is not sent', async () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue(range(4));
        transport.next(err('unknown', 404, 'Not Found (HTTP 404)'));
        await flush();
        expect(transport.calls.length).toBe(1);
        expect(q.stats()).toMatchObject({ queued: 0, failed: 4, paused: false });
        expect(hooks.onError).toHaveBeenCalledTimes(1);
    });
});

describe('lifecycle', () => {
    it('cancelQueued drops queued pixels and follow-ups, not in-flight ones', () => {
        const q = make({ initialConcurrency: 1 });
        q.enqueue(range(5));
        q.enqueue([px(0, 0, 6)]);
        expect(q.cancelQueued()).toBe(5);
        expect(q.pendingCount).toBe(1);
        expect(q.stats()).toMatchObject({ queued: 0, inFlight: 1 });
        expect(pending(q)).toEqual([{ x: 0, y: 0, color: 4, state: 'sending' }]);
        expect(q.cancelQueued()).toBe(0);
    });

    it('dispose aborts requests, clears timers and silences hooks', async () => {
        const q = make({ initialConcurrency: 2, confirmTimeoutMs: 1000 });
        q.enqueue(range(4));
        transport.next(OK);
        await flush();
        transport.next(E503);
        await flush();
        hooks.onChange.mockClear();
        hooks.onError.mockClear();
        const open = transport.open;
        q.dispose();
        expect(open.every((c) => c.signal?.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        for (const c of open) c.resolve(OK);
        q.confirm([{ x: 0, y: 0, color: 4 }]);
        expect(q.enqueue([px(9)])).toEqual({ queued: 0, skipped: 0, dropped: 1 });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(hooks.onChange).not.toHaveBeenCalled();
        expect(hooks.onError).not.toHaveBeenCalled();
        expect(transport.calls).toHaveLength(3);
    });

    it('coalesces onChange to once per microtask and bumps the version per change', async () => {
        const q = make({ initialConcurrency: 1 });
        const v0 = q.version;
        q.enqueue([px(1)]);
        const v1 = q.version;
        q.enqueue([px(2)]);
        q.enqueue([px(3)]);
        expect(v1).toBeGreaterThan(v0);
        expect(q.version).toBeGreaterThan(v1);
        expect(hooks.onChange).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(hooks.onChange).toHaveBeenCalledTimes(1);
        const v = q.version;
        q.enqueue([px(3)]);                   // duplicate: no change
        expect(q.version).toBe(v);
        await Promise.resolve();
        expect(hooks.onChange).toHaveBeenCalledTimes(1);
    });

    it('handles 20k pending pixels', () => {
        const q = make({ initialConcurrency: 1 });
        const reqs: DrawRequest[] = [];
        for (let i = 0; i < 20_000; i++) reqs.push(px(i % GRID_SIZE, Math.floor(i / GRID_SIZE), 1 + (i % 16)));
        expect(q.enqueue(reqs)).toEqual({ queued: 20_000, skipped: 0, dropped: 0 });
        let n = 0;
        const t = performance.now();
        q.forEachPending(() => n++);
        expect(n).toBe(20_000);
        expect(performance.now() - t).toBeLessThan(100);
        expect(q.stats()).toMatchObject({ queued: 19_999, inFlight: 1 });
    });
});
