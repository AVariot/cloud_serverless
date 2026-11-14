// Narrow interface between the chunk sync logic and Firestore, so the sync
// algorithm can be unit-tested with a fake source.

/** A pixels/{x}_{y} document, reduced to what rendering needs */
export interface PixelDoc {
    x: number;
    y: number;
    /** Palette id, 0 = empty */
    color: number;
    /** updated_at (Pub/Sub publish time, server clock), in ms since epoch */
    updatedAtMs: number;
}

export interface PixelChange extends PixelDoc {
    /** 'removed' means the document left the result set (deleted): treat as empty */
    type: 'added' | 'modified' | 'removed';
}

/** Opaque pagination cursor */
export type PageCursor = unknown;

export interface PixelPage {
    docs: PixelDoc[];
    /** null when this was the last page */
    next: PageCursor | null;
}

export interface ListenHandlers {
    /**
     * Called with the initial result set (as 'added' changes), then with each
     * batch of changes. fromCache = true while the SDK has not confirmed the
     * snapshot with the server (offline / connecting).
     */
    next(changes: PixelChange[], meta: { fromCache: boolean; initial: boolean }): void;
    /** Fatal listener error: the listener is dead and must be re-created */
    error(e: Error): void;
}

export interface PixelSource {
    /**
     * One page of the current state of up to 30 chunks:
     * where chunk in chunkIds, ordered by updated_at (then document id).
     */
    fetchPage(chunkIds: readonly string[], cursor: PageCursor | null, pageSize: number): Promise<PixelPage>;
    /**
     * Real-time listener on up to 30 chunks:
     * where chunk in chunkIds and updated_at > sinceMs. Returns the unsubscribe function.
     */
    listen(chunkIds: readonly string[], sinceMs: number, handlers: ListenHandlers): () => void;
    /** Fires each time every active listener is in sync with the server. Returns the unsubscribe function. */
    onInSync(cb: () => void): () => void;
}
