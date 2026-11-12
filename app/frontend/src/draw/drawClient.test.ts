import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawClient, type DrawClientConfig } from './drawClient';

// Only a mocked fetch is ever used here: no request leaves the process.
const GATEWAY = 'https://gateway.invalid';
const REQ = { x: 12, y: 34, color: 5 };

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return vi.fn<typeof fetch>(async () => new Response(text, { status, headers }));
}

function client(fetchImpl: typeof fetch, over: Partial<DrawClientConfig> = {}) {
    return new DrawClient({ gatewayUrl: `${GATEWAY}/`, apiKey: 'key-123', getToken: () => 'tok-abc', fetchImpl, ...over });
}

afterEach(() => {
    vi.useRealTimers();
});

describe('DrawClient', () => {
    it('POSTs one pixel with the expected headers and maps 202 to ok', async () => {
        const fetchImpl = respond(202, { event_id: 'ev-1', correlation_id: 'cid-body' });
        const res = await client(fetchImpl).draw(REQ);

        expect(res).toEqual({ ok: true, eventId: 'ev-1', correlationId: 'cid-body' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(`${GATEWAY}/draw`);
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ x: 12, y: 34, color: 5 });
        const h = init?.headers as Record<string, string>;
        expect(h['x-api-key']).toBe('key-123');
        expect(h.Authorization).toBe('Bearer tok-abc');
        expect(h['Content-Type']).toBe('application/json');
        expect(h['X-Correlation-Id']).toMatch(/^[0-9a-f]{32}$/);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('takes the correlation id from the body, then the header, then the generated one', async () => {
        const fromHeader = await client(respond(202, { event_id: 'e' }, { 'X-Correlation-Id': 'cid-header' })).draw(REQ);
        expect(fromHeader).toMatchObject({ ok: true, correlationId: 'cid-header' });

        const fetchImpl = respond(202, '');
        const generated = await client(fetchImpl).draw(REQ);
        const sent = (fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)['X-Correlation-Id'];
        expect(generated).toEqual({ ok: true, eventId: '', correlationId: sent });
    });

    it.each([
        ['proxy 400', 400, { error: 'x hors de la grille', correlation_id: 'c1' }, 'bad_request', 'x hors de la grille'],
        ['gateway 400 bad api key', 400, { message: 'INVALID_ARGUMENT: API key not valid. Please pass a valid API key.', code: 400 }, 'forbidden', /Clé API refusée/],
        ['proxy 401 missing token', 401, { error: 'authentification requise', correlation_id: 'c2' }, 'unauthorized', 'authentification requise'],
        ['proxy 401 bad token', 401, { error: 'jeton invalide' }, 'unauthorized', 'jeton invalide'],
        ['gateway 401 missing key', 401, { message: "UNAUTHENTICATED: Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.", code: 401 }, 'forbidden', /UNAUTHENTICATED/],
        ['gateway 403', 403, { message: 'PERMISSION_DENIED: API not enabled', code: 403 }, 'forbidden', 'PERMISSION_DENIED: API not enabled'],
        ['gateway 429 quota', 429, { message: 'RESOURCE_EXHAUSTED: Quota exceeded', code: 429 }, 'rate_limited', 'RESOURCE_EXHAUSTED: Quota exceeded'],
        ['proxy 503 auth', 503, { error: 'authentification indisponible' }, 'unavailable', 'authentification indisponible'],
        ['proxy 503 queue', 503, { error: 'file indisponible' }, 'unavailable', 'file indisponible'],
        ['html 502', 502, '<html><body>Bad Gateway</body></html>', 'unavailable', 'Service indisponible (HTTP 502)'],
        ['empty 500', 500, '', 'unavailable', 'Service indisponible (HTTP 500)'],
        ['408', 408, '', 'unavailable', /Délai/],
        ['empty 401', 401, '', 'unauthorized', /reconnectez-vous/],
        ['non-JSON 400', 400, 'oops', 'bad_request', /invalides/],
        ['JSON array 400', 400, '[1,2]', 'bad_request', /invalides/],
        ['404', 404, '', 'unknown', 'Réponse inattendue (HTTP 404)'],
        ['423 paused canvas', 423, { error: 'toile en pause' }, 'unknown', 'toile en pause (HTTP 423)'],
    ] as const)('%s -> %s', async (_name, status, body, kind, message) => {
        const res = await client(respond(status, body, { 'X-Correlation-Id': 'cid-h' })).draw(REQ);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.kind).toBe(kind);
        expect(res.status).toBe(status);
        if (typeof message === 'string') expect(res.message).toBe(message);
        else expect(res.message).toMatch(message);
        const bodyCid = typeof body === 'object' && 'correlation_id' in body ? body.correlation_id : undefined;
        expect(res.correlationId).toBe(bodyCid ?? 'cid-h');
    });

    it('reads a retry delay for 429 when one is readable', async () => {
        const header = await client(respond(429, '', { 'Retry-After': '7' })).draw(REQ);
        expect(header).toMatchObject({ ok: false, kind: 'rate_limited', retryAfterMs: 7000 });
        const body = await client(respond(429, { error: 'trop de pixels', retry_after: 3 })).draw(REQ);
        expect(body).toMatchObject({ ok: false, kind: 'rate_limited', retryAfterMs: 3000, message: 'trop de pixels' });
        const none = await client(respond(429, '')).draw(REQ);
        expect(none).toMatchObject({ ok: false, kind: 'rate_limited' });
        expect(none.ok === false && none.retryAfterMs).toBeUndefined();
    });

    it('resolves unauthorized without calling fetch when there is no token', async () => {
        const fetchImpl = respond(202, {});
        expect(await client(fetchImpl, { getToken: () => null }).draw(REQ)).toMatchObject({ ok: false, kind: 'unauthorized', status: 0 });
        expect(await client(fetchImpl, { getToken: () => '' }).draw(REQ)).toMatchObject({ ok: false, kind: 'unauthorized', status: 0 });
        const throwing = () => {
            throw new Error('no document');
        };
        expect(await client(fetchImpl, { getToken: throwing }).draw(REQ)).toMatchObject({ ok: false, kind: 'unauthorized', status: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('resolves forbidden without calling fetch when the gateway is not configured', async () => {
        const fetchImpl = respond(202, {});
        expect(await client(fetchImpl, { gatewayUrl: '' }).draw(REQ)).toMatchObject({ ok: false, kind: 'forbidden', status: 0 });
        expect(await client(fetchImpl, { apiKey: ' ' }).draw(REQ)).toMatchObject({ ok: false, kind: 'forbidden', status: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('maps fetch failures (TypeError, synchronous throw) to network', async () => {
        const rejecting = vi.fn<typeof fetch>(async () => {
            throw new TypeError('Failed to fetch');
        });
        expect(await client(rejecting).draw(REQ)).toMatchObject({ ok: false, kind: 'network', status: 0 });
        const throwing = vi.fn<typeof fetch>(() => {
            throw new TypeError('sync');
        });
        const res = await client(throwing).draw(REQ);
        expect(res).toMatchObject({ ok: false, kind: 'network' });
        expect(res.ok === false && res.correlationId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('aborts after timeoutMs and resolves network', async () => {
        vi.useFakeTimers();
        let seen: AbortSignal | undefined;
        const hanging = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
            seen = init?.signal ?? undefined;
            seen?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const pending = client(hanging, { timeoutMs: 2000 }).draw(REQ);
        await vi.advanceTimersByTimeAsync(1999);
        expect(seen?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const res = await pending;
        expect(seen?.aborted).toBe(true);
        expect(res).toMatchObject({ ok: false, kind: 'network', status: 0 });
        expect(res.ok === false && res.message).toMatch(/Délai dépassé/);
    });

    it('uses 10 s as the default timeout', async () => {
        vi.useFakeTimers();
        const hanging = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        let done = false;
        const pending = client(hanging).draw(REQ).then((r) => {
            done = true;
            return r;
        });
        await vi.advanceTimersByTimeAsync(9999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ ok: false, kind: 'network' });
    });

    it('honours the caller signal', async () => {
        const ctrl = new AbortController();
        const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const pending = client(fetchImpl).draw(REQ, ctrl.signal);
        ctrl.abort();
        expect(await pending).toMatchObject({ ok: false, kind: 'network', message: 'Requête annulée' });

        const already = new AbortController();
        already.abort();
        const unused = respond(202, {});
        expect(await client(unused).draw(REQ, already.signal)).toMatchObject({ ok: false, kind: 'network' });
        expect(unused).not.toHaveBeenCalled();
    });

    it('reads the token on every request', async () => {
        let token = 'first';
        const fetchImpl = respond(202, { event_id: 'e' });
        const c = client(fetchImpl, { getToken: () => token });
        await c.draw(REQ);
        token = 'second';
        await c.draw(REQ);
        const auth = fetchImpl.mock.calls.map((call) => (call[1]?.headers as Record<string, string>).Authorization);
        expect(auth).toEqual(['Bearer first', 'Bearer second']);
    });
});
