// Firestore implementation of PixelSource over the `pixels` collection (one doc
// per painted pixel: x, y, color, user_id, chunk "cx_cy", updated_at).
import {
    collection,
    documentId,
    getDocsFromServer,
    limit,
    onSnapshot,
    onSnapshotsInSync,
    orderBy,
    query,
    startAfter,
    Timestamp,
    where,
    type CollectionReference,
    type DocumentData,
    type Firestore,
    type QueryConstraint,
    type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { CHUNKS_PER_SIDE, chunkKey, chunkKeyOfPixel, isInGrid } from '../config';
import type { ListenHandlers, PageCursor, PixelChange, PixelDoc, PixelPage, PixelSource } from './PixelSource';

/** Firestore's limit on the number of values of an `in` filter */
export const MAX_IN_VALUES = 30;

// Same format as the backend's chunkID(): no leading zeros, so "05_3" can never match a doc
const CHUNK_ID_RE = /^(0|[1-9]\d?)_(0|[1-9]\d?)$/;

/**
 * Validates "cx_cy" ids and returns their numeric chunk keys. Throws when the
 * list cannot be sent as one `in` filter or holds ids the backend never writes.
 */
export function parseChunkIds(chunkIds: readonly string[]): Set<number> {
    if (chunkIds.length < 1 || chunkIds.length > MAX_IN_VALUES) {
        throw new RangeError(`chunkIds must hold 1..${MAX_IN_VALUES} ids (got ${chunkIds.length})`);
    }
    const keys = new Set<number>();
    for (const id of chunkIds) {
        const m = CHUNK_ID_RE.exec(id);
        const cx = m ? Number(m[1]) : -1;
        const cy = m ? Number(m[2]) : -1;
        if (cx < 0 || cy < 0 || cx >= CHUNKS_PER_SIDE || cy >= CHUNKS_PER_SIDE) throw new RangeError(`Invalid chunk id "${id}"`);
        keys.add(chunkKey(cx, cy));
    }
    return keys;
}

/** Firestore Timestamp -> ms since epoch; anything else (missing, wrong type) -> 0 */
export function timestampToMillis(value: unknown): number {
    if (value instanceof Timestamp) return value.toMillis();
    // Duck typing covers a Timestamp from another copy of the SDK
    if (value !== null && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
        const ms = (value as { toMillis(): unknown }).toMillis();
        return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
    }
    return 0;
}

/** Palette id stored in a doc; anything that is not an integer in 0..255 renders as empty */
export function paletteColor(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255 ? value : 0;
}

/**
 * Reduces a pixel doc to what rendering needs. Returns null for docs that cannot
 * be placed: x/y not integers inside the grid, or (when `allowed` is given) x/y
 * outside the chunks that were queried (a doc whose `chunk` field disagrees
 * with its coordinates must not land in a chunk we did not ask for).
 */
export function toPixelDoc(data: DocumentData, allowed: ReadonlySet<number> | null): PixelDoc | null {
    const x: unknown = data.x;
    const y: unknown = data.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !isInGrid(x, y)) return null;
    if (allowed !== null && !allowed.has(chunkKeyOfPixel(x, y))) return null;
    return { x, y, color: paletteColor(data.color), updatedAtMs: timestampToMillis(data.updated_at) };
}

export class FirestorePixelSource implements PixelSource {
    private readonly db: Firestore;
    private readonly pixels: CollectionReference<DocumentData>;

    constructor(db: Firestore) {
        this.db = db;
        this.pixels = collection(db, 'pixels');
    }

    async fetchPage(chunkIds: readonly string[], cursor: PageCursor | null, pageSize: number): Promise<PixelPage> {
        const allowed = parseChunkIds(chunkIds);
        if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`Invalid pageSize ${pageSize}`);
        // updated_at then document id: a total order, so the cursor never skips
        // docs sharing the same updated_at. Served by the (chunk, updated_at) index,
        // whose implicit last field is __name__ ASC.
        const constraints: QueryConstraint[] = [
            where('chunk', 'in', uniqueIds(chunkIds)),
            orderBy('updated_at'),
            orderBy(documentId()),
        ];
        if (cursor !== null && cursor !== undefined) constraints.push(startAfter(cursor as QueryDocumentSnapshot));
        constraints.push(limit(pageSize));

        // getDocsFromServer, not getDocs: offline, getDocs resolves with whatever the
        // memory cache holds (usually nothing), which the caller would take for a
        // complete page and mark the chunk loaded with holes. FromServer rejects
        // instead, so the page is retried. Both go through the shared watch stream.
        const snap = await getDocsFromServer(query(this.pixels, ...constraints));

        const docs: PixelDoc[] = [];
        for (const d of snap.docs) {
            const pixel = toPixelDoc(d.data(), allowed);
            if (pixel) docs.push(pixel);
        }
        // The cursor is the raw last snapshot, even if its content was rejected,
        // so a malformed doc can never stall pagination.
        const last = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
        return { docs, next: last !== null && snap.docs.length >= pageSize ? last : null };
    }

    listen(chunkIds: readonly string[], sinceMs: number, handlers: ListenHandlers): () => void {
        const allowed = parseChunkIds(chunkIds);
        const since = Timestamp.fromMillis(Number.isFinite(sinceMs) ? Math.max(0, sinceMs) : 0);
        const q = query(this.pixels, where('chunk', 'in', uniqueIds(chunkIds)), where('updated_at', '>', since));
        let initial = true;
        // includeMetadataChanges: fromCache flips (offline <-> in sync) arrive as
        // snapshots without doc changes; they are forwarded so the caller can
        // track the connection state per listener.
        return onSnapshot(q, { includeMetadataChanges: true }, {
            next: (snap) => {
                const changes: PixelChange[] = [];
                for (const change of snap.docChanges()) {
                    const pixel = toPixelDoc(change.doc.data(), allowed);
                    if (!pixel) continue;
                    // 'removed' = the doc left the result set (deleted): the pixel is empty again
                    changes.push({
                        x: pixel.x,
                        y: pixel.y,
                        color: change.type === 'removed' ? 0 : pixel.color,
                        updatedAtMs: pixel.updatedAtMs,
                        type: change.type,
                    });
                }
                const first = initial;
                initial = false;
                handlers.next(changes, { fromCache: snap.metadata.fromCache, initial: first });
            },
            error: (e) => handlers.error(e),
        });
    }

    onInSync(cb: () => void): () => void {
        return onSnapshotsInSync(this.db, cb);
    }
}

function uniqueIds(chunkIds: readonly string[]): string[] {
    return [...new Set(chunkIds)];
}
