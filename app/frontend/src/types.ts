// Contracts shared by the engine, the data layer (Firestore), the draw pipeline
// (POST /draw) and the UI. Keep this file free of runtime code.

/** One pixel's color as stored in Firestore: palette id, 0 = empty */
export interface PixelUpdate {
    x: number;
    y: number;
    color: number;
}

/** Inclusive rectangle of chunk coordinates */
export interface ChunkRect {
    cx0: number;
    cy0: number;
    cx1: number;
    cy1: number;
}

// ---------------------------------------------------------------------------
// Data layer (Firestore -> engine)
// ---------------------------------------------------------------------------

export type ChunkState = 'unloaded' | 'loading' | 'loaded';

/**
 * Where the sync layer writes what it reads. Implemented by the runtime, which
 * forwards to the engine's ChunkStore (and to the draw queue for confirmations).
 * Every call is synchronous and cheap; `applyPixels` receives batches.
 */
export interface ChunkSink {
    /** The chunk starts loading: its previous content (if any) is discarded */
    beginLoad(cx: number, cy: number): void;
    /** Pixel values read from Firestore (initial pages or live deltas). Unknown chunks are ignored. */
    applyPixels(updates: readonly PixelUpdate[]): void;
    /** Every page of the chunk has been applied: it now shows the full state */
    finishLoad(cx: number, cy: number): void;
    /** The chunk's data is dropped from memory (back to 'unloaded') */
    evict(cx: number, cy: number): void;
}

/** connecting: no in-sync snapshot yet / live: up to date / offline: no network / error: a listener failed and is retrying */
export type SyncStatus = 'connecting' | 'live' | 'offline' | 'error';

export interface SyncStats {
    status: SyncStatus;
    /** Chunks wanted for the current view (visible + preload ring) */
    needed: number;
    /** Chunks currently paginating their initial state */
    loading: number;
    /** Chunks fully loaded and kept in memory (live or cached) */
    loaded: number;
    /** Chunks covered by an active real-time listener */
    live: number;
    /** Active Firestore listeners */
    listeners: number;
    /** Documents read since start (pages + listener events), for cost awareness */
    docsRead: number;
    /** Last error message, if any */
    error?: string;
}

// ---------------------------------------------------------------------------
// Draw pipeline (UI/engine -> POST /draw)
// ---------------------------------------------------------------------------

export interface DrawRequest {
    x: number;
    y: number;
    color: number; // palette id, never 0
}

export type DrawErrorKind =
    | 'bad_request'   // 400: invalid body (message from the server)
    | 'unauthorized'  // 401: missing or rejected Discord token -> log in again
    | 'forbidden'     // 403: API key / CORS refused by the gateway
    | 'rate_limited'  // 429: slow down (retryAfterMs when known)
    | 'unavailable'   // 503 / 5xx: transient, retried
    | 'network'       // fetch failed (offline, CORS, DNS)
    | 'unknown';

export type DrawResult =
    | { ok: true; eventId: string; correlationId: string }
    | { ok: false; kind: DrawErrorKind; status: number; message: string; retryAfterMs?: number; correlationId?: string };

/**
 * queued: waiting in the client queue / sending: POST in flight /
 * accepted: 202 received, waiting for the Firestore listener to confirm
 */
export type PendingState = 'queued' | 'sending' | 'accepted';

export interface PendingPixel {
    x: number;
    y: number;
    color: number;
    state: PendingState;
}

export interface DrawStats {
    queued: number;
    inFlight: number;
    /** 202 received, not yet seen through the listener */
    awaiting: number;
    /** Seen through the listener with the requested color (since start) */
    confirmed: number;
    /** Definitively rejected (400/401/403, retries exhausted) since start */
    failed: number;
    /** Accepted but never seen within the confirmation timeout, since start */
    unconfirmed: number;
    /** True while the queue is paused (429 backoff, 401, offline) */
    paused: boolean;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type Tool = 'select' | 'brush';
export type BrushShape = 'square' | 'round';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
    id: number;
    kind: ToastKind;
    message: string;
    detail?: string;
    /** Toasts with the same key replace each other instead of stacking */
    key?: string;
}

/** Live content of one Firestore pixel document, for the inspector */
export type PixelInfo =
    | { status: 'loading' }
    | { status: 'empty' }                       // document does not exist: never painted
    | { status: 'error'; message: string }
    | { status: 'ready'; color: number; userId: string; updatedAtMs: number };
