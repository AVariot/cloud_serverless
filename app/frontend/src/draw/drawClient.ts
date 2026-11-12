// HTTP client for POST {gateway}/draw (one pixel per request).
// It never throws: every outcome, including network failures and timeouts, is
// mapped to a DrawResult so the queue only deals with classified results.
import type { DrawErrorKind, DrawRequest, DrawResult } from '../types';

export interface DrawClientConfig {
    gatewayUrl: string;
    apiKey: string;
    /** Discord OAuth2 access token (read on every request: it can change after a re-login) */
    getToken: () => string | null;
    fetchImpl?: typeof fetch;
    /** Default 10000 */
    timeoutMs?: number;
}

export interface DrawTransport {
    draw(req: DrawRequest, signal?: AbortSignal): Promise<DrawResult>;
}

type DrawFailure = Extract<DrawResult, { ok: false }>;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SERVER_TEXT = 300;
const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** Fields we may find in a response body (proxy shape or gateway shape) */
interface ParsedBody {
    error?: string;      // proxy: {"error": "...", "correlation_id": "..."}
    message?: string;    // gateway (ESPv2): {"message": "...", "code": N}
    eventId?: string;
    correlationId?: string;
    retryAfterMs?: number;
}

/** 32 hex chars: short enough for log searches, unique enough for tracing */
export function newCorrelationId(): string {
    const c = globalThis.crypto;
    // randomUUID only exists in secure contexts (https, localhost)
    if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
    let id = '';
    for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
}

export class DrawClient implements DrawTransport {
    private readonly endpoint: string;
    private readonly apiKey: string;
    private readonly getToken: () => string | null;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(cfg: DrawClientConfig) {
        const base = cfg.gatewayUrl.trim().replace(/\/+$/, '');
        this.endpoint = base ? `${base}/draw` : '';
        this.apiKey = cfg.apiKey.trim();
        this.getToken = cfg.getToken;
        // Wrapped so the global fetch is never called with a foreign `this` ("Illegal invocation")
        this.fetchImpl = cfg.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
        this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    async draw(req: DrawRequest, signal?: AbortSignal): Promise<DrawResult> {
        // Missing configuration: re-logging would not help, hence 'forbidden'. Never
        // fall back to a relative URL, which would hit whatever serves the page.
        if (!this.endpoint || !this.apiKey) {
            return fail('forbidden', 0, 'Passerelle non configurée (VITE_GATEWAY_URL / VITE_PIXEL_API_KEY)');
        }
        let token: string | null;
        try {
            token = this.getToken();
        } catch {
            token = null;
        }
        if (!token) return fail('unauthorized', 0, 'Connectez-vous avec Discord pour dessiner');

        const correlationId = newCorrelationId();
        if (signal?.aborted) return fail('network', 0, 'Requête annulée', correlationId);

        const ctrl = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            ctrl.abort();
        }, this.timeoutMs);
        const onAbort = () => ctrl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
            let res: Response;
            try {
                res = await this.fetchImpl(this.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this.apiKey,
                        Authorization: `Bearer ${token}`,
                        'X-Correlation-Id': correlationId,
                    },
                    body: JSON.stringify({ x: req.x, y: req.y, color: req.color }),
                    signal: ctrl.signal,
                });
            } catch {
                // TypeError (offline, DNS, CORS refusal) or AbortError (timeout / caller)
                return fail('network', 0, abortMessage(timedOut, signal, this.timeoutMs), correlationId);
            }

            // The body is read under the same timeout: a stalled body must not hang the queue
            let text = '';
            try {
                text = await res.text();
            } catch {
                if (timedOut || signal?.aborted) {
                    return fail('network', 0, abortMessage(timedOut, signal, this.timeoutMs), correlationId);
                }
                text = '';
            }
            const body = parseBody(text);
            const cid = body.correlationId || res.headers.get('X-Correlation-Id') || correlationId;

            if (res.ok) return { ok: true, eventId: body.eventId ?? '', correlationId: cid };

            const { kind, message } = classify(res.status, body);
            const result: DrawFailure = { ok: false, kind, status: res.status, message, correlationId: cid };
            if (kind === 'rate_limited') {
                const retryAfterMs = body.retryAfterMs ?? parseRetryAfter(res.headers.get('Retry-After'));
                if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
            }
            return result;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }
}

function fail(kind: DrawErrorKind, status: number, message: string, correlationId?: string): DrawResult {
    return correlationId ? { ok: false, kind, status, message, correlationId } : { ok: false, kind, status, message };
}

function abortMessage(timedOut: boolean, signal: AbortSignal | undefined, timeoutMs: number): string {
    if (timedOut) return `Délai dépassé (${Math.round(timeoutMs / 1000)} s) : passerelle injoignable`;
    if (signal?.aborted) return 'Requête annulée';
    return 'Réseau indisponible : impossible de joindre la passerelle';
}

const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_SERVER_TEXT) : undefined;

/** Tolerates empty bodies, HTML error pages and unexpected JSON shapes */
function parseBody(text: string): ParsedBody {
    if (!text) return {};
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const o = raw as Record<string, unknown>;
    const out: ParsedBody = {
        error: str(o.error),
        message: str(o.message),
        eventId: str(o.event_id),
        correlationId: str(o.correlation_id),
    };
    // A future rate limiter may describe the wait in the body (Retry-After is not exposed by CORS)
    if (typeof o.retry_after_ms === 'number') out.retryAfterMs = clampRetry(o.retry_after_ms);
    else if (typeof o.retry_after === 'number') out.retryAfterMs = clampRetry(o.retry_after * 1000);
    return out;
}

function clampRetry(ms: number): number | undefined {
    return Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), MAX_RETRY_AFTER_MS) : undefined;
}

/** Retry-After: delta-seconds or HTTP date; usually unreadable cross-origin (null) */
function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const v = value.trim();
    if (/^\d+(\.\d+)?$/.test(v)) return clampRetry(Number(v) * 1000);
    const at = Date.parse(v);
    return Number.isNaN(at) ? undefined : clampRetry(Math.max(0, at - Date.now()));
}

/** API key / unregistered caller errors come from the gateway, not from the Discord check */
const API_KEY_RE = /api[ _-]?key|unregistered callers/i;

function classify(status: number, body: ParsedBody): { kind: DrawErrorKind; message: string } {
    // Gateway errors use {"message","code"}, the proxy uses {"error"}
    const gateway = body.error === undefined && body.message !== undefined;
    const gatewayText = gateway ? body.message : undefined;
    const serverText = body.error ?? body.message;

    if (gateway && API_KEY_RE.test(gatewayText ?? '') && (status === 400 || status === 401 || status === 403)) {
        return { kind: 'forbidden', message: `Clé API refusée par la passerelle (${gatewayText})` };
    }
    switch (status) {
        case 400:
            return { kind: 'bad_request', message: serverText ?? 'Requête refusée par le serveur (données invalides)' };
        case 401:
            if (gateway) return { kind: 'forbidden', message: `Appel refusé par la passerelle (${gatewayText})` };
            return { kind: 'unauthorized', message: body.error ?? 'Session Discord expirée : reconnectez-vous' };
        case 403:
            return { kind: 'forbidden', message: serverText ?? 'Accès refusé par la passerelle' };
        case 408:
            return { kind: 'unavailable', message: serverText ?? 'Délai dépassé côté serveur' };
        case 429:
            return { kind: 'rate_limited', message: serverText ?? 'Trop de pixels envoyés : ralentissement' };
    }
    if (status >= 500) return { kind: 'unavailable', message: serverText ?? `Service indisponible (HTTP ${status})` };
    return { kind: 'unknown', message: serverText ? `${serverText} (HTTP ${status})` : `Réponse inattendue (HTTP ${status})` };
}
