import { CHUNK_AREA, CHUNK_SIZE, CHUNKS_PER_SIDE, chunkKey, chunkKeyOfPixel, isInGrid, localIndex } from '../config';
import { PALETTE_LUT } from '../palette';
import type { ChunkState, PixelUpdate } from '../types';
import { MAX_LOD, downsampleRegion, lodSize, preferTexelUploads, textureBytes } from './lod';

// GPU memory for chunk textures. Textures not drawn this frame are evicted first
// (least recently drawn first). 400 chunks x 250 KB is 100 MB, so this only
// matters if CHUNK_SIZE or the texture formats change.
const TEXTURE_BUDGET_BYTES = 384 * 1024 * 1024;
// Time spent building/updating textures per frame; the rest waits for the next frames
const BUILD_BUDGET_MS = 6;
// Changed texels remembered one by one per texture; beyond, only their bounding rectangle
const MAX_DIRTY_TEXELS = 256;
/**
 * Texture unit used for uploads, never sampled by a draw: binding a texture to
 * upload it can never leave an R8UI texture on a unit read by a float sampler
 * (or the reverse), which would make the next draw fail.
 */
export const UPLOAD_TEXTURE_UNIT = 3;

// Shared upload buffers (the largest RGBA upload is a whole lod-1 texture)
let rgbaScratch: Uint8Array | null = null;
const scratch = () => (rgbaScratch ??= new Uint8Array(lodSize(1) ** 2 * 4));
const texel4 = new Uint8Array(4);

/** What the Renderer needs to draw one visible chunk */
export interface DrawableChunk {
    readonly cx: number;
    readonly cy: number;
    /** Initial pages still arriving: empty ids are unknown, drawn as the "unloaded" pattern */
    readonly loading: boolean;
    /** null: loaded chunk without any painted pixel, drawn as a plain white quad */
    readonly texture: WebGLTexture | null;
    /** 0: R8UI palette ids, CHUNK_SIZE^2 / >= 1: RGBA8 colors at 1 / 2^lod resolution */
    readonly textureLod: number;
}

const isChunkCoord = (cx: number, cy: number) =>
    Number.isInteger(cx) && Number.isInteger(cy) && cx >= 0 && cy >= 0 && cx < CHUNKS_PER_SIDE && cy < CHUNKS_PER_SIDE;

const byPriority = (a: Chunk, b: Chunk) => a.priority - b.priority;

// Sorts a short list of texel indices and removes duplicates, in place
function dedupe(list: number[]): number[] {
    list.sort((a, b) => a - b);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
        if (i === 0 || list[i] !== list[n - 1]) list[n++] = list[i];
    }
    list.length = n;
    return list;
}

class Chunk implements DrawableChunk {
    readonly cx: number;
    readonly cy: number;
    state: 'loading' | 'loaded' = 'loading';
    /** Palette ids, row-major; allocated on the first non-zero write */
    ids: Uint8Array | null = null;

    texture: WebGLTexture | null = null;
    textureLod = 0;
    textureSize = 0;
    lastUsedFrame = 0;
    priority = 0; // build order inside a frame, lower first

    // Changes not uploaded yet, in texel coordinates of the current texture:
    // bounding rectangle (inclusive, dx0 < 0 = clean) + texel list while short
    dx0 = -1;
    dy0 = 0;
    dx1 = 0;
    dy1 = 0;
    dirtyTexels: number[] = [];
    dirtyOverflow = false;

    constructor(cx: number, cy: number) {
        this.cx = cx;
        this.cy = cy;
    }

    get loading() {
        return this.state === 'loading';
    }

    get dirty() {
        return this.dx0 >= 0;
    }

    // Without a texture there is nothing to patch: the next build reads everything
    markDirty(lx: number, ly: number) {
        if (!this.texture) return;
        const tx = lx >> this.textureLod, ty = ly >> this.textureLod;
        if (this.dx0 < 0) {
            this.dx0 = this.dx1 = tx;
            this.dy0 = this.dy1 = ty;
        } else {
            if (tx < this.dx0) this.dx0 = tx; else if (tx > this.dx1) this.dx1 = tx;
            if (ty < this.dy0) this.dy0 = ty; else if (ty > this.dy1) this.dy1 = ty;
        }
        if (this.dirtyOverflow) return;
        const list = this.dirtyTexels;
        const i = ty * this.textureSize + tx;
        if (list[list.length - 1] === i) return; // neighbours often share a cell at lod >= 1
        if (list.length < MAX_DIRTY_TEXELS) list.push(i);
        else {
            this.dirtyOverflow = true;
            list.length = 0;
        }
    }

    clearDirty() {
        this.dx0 = -1;
        this.dirtyTexels.length = 0;
        this.dirtyOverflow = false;
    }
}

// Palette-id storage for loaded chunks (CPU) and textures for the chunks on
// screen (GPU), sized to their on-screen footprint.
export class ChunkStore {
    private readonly gl: WebGL2RenderingContext;
    private readonly chunks = new Map<number, Chunk>(); // 'loading' | 'loaded'; absent = 'unloaded'
    private readonly textured = new Set<Chunk>();
    private gpuBytes = 0;
    private frame = 0;
    private deferred = false;
    private warnedOOM = false;
    // Reused every frame
    private readonly drawList: DrawableChunk[] = [];
    private readonly candidates: Chunk[] = [];
    private readonly work: Chunk[] = [];

    constructor(gl: WebGL2RenderingContext) {
        this.gl = gl;
    }

    // ---- Data plane ----

    state(cx: number, cy: number): ChunkState {
        if (!isChunkCoord(cx, cy)) return 'unloaded';
        return this.chunks.get(chunkKey(cx, cy))?.state ?? 'unloaded';
    }

    beginLoad(cx: number, cy: number): void {
        if (!isChunkCoord(cx, cy)) return;
        const key = chunkKey(cx, cy);
        const chunk = this.chunks.get(key);
        if (!chunk) {
            this.chunks.set(key, new Chunk(cx, cy));
            return;
        }
        this.dropTexture(chunk);
        chunk.ids = null;
        chunk.state = 'loading';
    }

    finishLoad(cx: number, cy: number): void {
        if (!isChunkCoord(cx, cy)) return;
        const chunk = this.chunks.get(chunkKey(cx, cy));
        // The lod-0 texture holds the same ids either way: only the shader mode changes
        if (chunk?.state === 'loading') chunk.state = 'loaded';
    }

    evict(cx: number, cy: number): void {
        if (!isChunkCoord(cx, cy)) return;
        const key = chunkKey(cx, cy);
        const chunk = this.chunks.get(key);
        if (!chunk) return;
        this.dropTexture(chunk);
        this.chunks.delete(key);
    }

    /**
     * Writes palette ids into 'loading'/'loaded' chunks. Updates for unloaded
     * chunks, outside the grid or with an id outside 0..255 are ignored.
     * Returns true when a stored id changed (the frame needs redrawing).
     */
    applyPixels(updates: readonly PixelUpdate[]): boolean {
        let changed = false;
        // Batches usually come chunk by chunk (pages): cache the last lookup
        let lastKey = -1;
        let chunk: Chunk | undefined;
        for (let i = 0; i < updates.length; i++) {
            const { x, y, color } = updates[i];
            if (!isInGrid(x, y) || (color | 0) !== color || color < 0 || color > 255) continue;
            const key = chunkKeyOfPixel(x, y);
            if (key !== lastKey) {
                lastKey = key;
                chunk = this.chunks.get(key);
            }
            if (!chunk) continue;
            const lx = x % CHUNK_SIZE, ly = y % CHUNK_SIZE;
            const index = ly * CHUNK_SIZE + lx;
            let ids = chunk.ids;
            if (!ids) {
                if (color === 0) continue; // already empty: keep the chunk buffer-less
                ids = this.allocate(chunk);
                if (!ids) continue;
            }
            if (ids[index] === color) continue;
            ids[index] = color;
            chunk.markDirty(lx, ly);
            changed = true;
        }
        return changed;
    }

    /** Palette id (0 = empty) when the chunk is fully loaded, null when unknown */
    getPixel(x: number, y: number): number | null {
        if (!isInGrid(x, y)) return null;
        const chunk = this.chunks.get(chunkKeyOfPixel(x, y));
        if (chunk?.state !== 'loaded') return null;
        return chunk.ids ? chunk.ids[localIndex(x, y)] : 0;
    }

    stats(): { loaded: number; loading: number; withData: number; cpuBytes: number; gpuBytes: number; textures: number } {
        let loaded = 0, loading = 0, withData = 0;
        for (const chunk of this.chunks.values()) {
            if (chunk.state === 'loaded') loaded++; else loading++;
            if (chunk.ids) withData++;
        }
        return { loaded, loading, withData, cpuBytes: withData * CHUNK_AREA, gpuBytes: this.gpuBytes, textures: this.textured.size };
    }

    // ---- GPU plane ----

    /** True when visible chunks still wait for a texture build or update: render another frame */
    get hasDeferredWork(): boolean {
        return this.deferred;
    }

    /**
     * Returns the chunks to draw in an inclusive chunk rectangle, with textures
     * built or updated for `lod`, closest to (focusX, focusY) (world px) first.
     * Work beyond the per-frame time budget is deferred (see hasDeferredWork);
     * meanwhile chunks keep drawing their previous texture, or are skipped
     * (background pattern) if they have none yet. The returned array is reused
     * by the next call.
     */
    prepareVisible(cx0: number, cy0: number, cx1: number, cy1: number, lod: number, focusX?: number, focusY?: number): readonly DrawableChunk[] {
        const out = this.drawList;
        out.length = 0;
        this.deferred = false;
        const frame = ++this.frame;
        const gl = this.gl;
        if (gl.isContextLost()) return out;

        cx0 = Math.max(0, cx0);
        cy0 = Math.max(0, cy0);
        cx1 = Math.min(CHUNKS_PER_SIDE - 1, cx1);
        cy1 = Math.min(CHUNKS_PER_SIDE - 1, cy1);
        lod = Math.min(MAX_LOD, Math.max(0, Math.floor(lod) || 0));
        const fx = focusX ?? ((cx0 + cx1 + 1) * CHUNK_SIZE) / 2;
        const fy = focusY ?? ((cy0 + cy1 + 1) * CHUNK_SIZE) / 2;

        const candidates = this.candidates, work = this.work;
        candidates.length = 0;
        work.length = 0;
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const chunk = this.chunks.get(chunkKey(cx, cy));
                if (!chunk) continue;
                if (!chunk.ids) {
                    if (chunk.state === 'loaded') out.push(chunk); // white quad, no texture
                    continue;
                }
                // Empty ids of a loading chunk are unknown: only exact ids (lod 0) can show that
                if (chunk.state === 'loading' && lod !== 0) continue;
                // Marked before any build so a build never evicts a texture drawn this frame
                chunk.lastUsedFrame = frame;
                candidates.push(chunk);
                if (chunk.texture && chunk.textureLod === lod) {
                    if (!chunk.dirty) continue;
                    chunk.priority = -1; // live updates of on-screen textures go first
                } else {
                    const dx = (cx + 0.5) * CHUNK_SIZE - fx, dy = (cy + 0.5) * CHUNK_SIZE - fy;
                    // Chunks with no texture at all (drawn as "not loaded" stripes) before
                    // chunks that only need a rebuild at the new LOD (their old texture still shows)
                    chunk.priority = (chunk.texture ? 1e12 : 0) + dx * dx + dy * dy;
                }
                work.push(chunk);
            }
        }

        if (work.length > 0) {
            work.sort(byPriority);
            gl.activeTexture(gl.TEXTURE0 + UPLOAD_TEXTURE_UNIT);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            const start = performance.now();
            for (let i = 0; i < work.length; i++) {
                // The first item always runs, so every frame makes progress
                if (i > 0 && performance.now() - start >= BUILD_BUDGET_MS) {
                    this.deferred = true;
                    break;
                }
                const chunk = work[i];
                if (chunk.texture && chunk.textureLod === lod) this.flush(chunk);
                else this.build(chunk, lod);
            }
        }

        for (const chunk of candidates) if (chunk.texture) out.push(chunk);
        return out;
    }

    /** After webglcontextrestored: every GL object is already gone, rebuild on demand */
    restore(): void {
        for (const chunk of this.textured) {
            chunk.texture = null;
            chunk.clearDirty();
        }
        this.textured.clear();
        this.gpuBytes = 0;
        this.deferred = false;
    }

    dispose(): void {
        for (const chunk of [...this.textured]) this.dropTexture(chunk);
        this.chunks.clear();
        this.drawList.length = 0;
        this.candidates.length = 0;
        this.work.length = 0;
        this.deferred = false;
    }

    // ---- Internals ----

    private allocate(chunk: Chunk): Uint8Array | null {
        try {
            return (chunk.ids = new Uint8Array(CHUNK_AREA));
        } catch (e) {
            // Out of memory: drop writes instead of crashing the app
            if (!this.warnedOOM) console.warn('[ChunkStore] chunk buffer allocation failed, pixel writes are being dropped', e);
            this.warnedOOM = true;
            return null;
        }
    }

    // (Re)creates the chunk texture at `lod` with its full current content
    private build(chunk: Chunk, lod: number): void {
        const ids = chunk.ids;
        if (!ids) return;
        const bytes = textureBytes(lod);
        const delta = bytes - (chunk.texture ? textureBytes(chunk.textureLod) : 0);
        if (this.gpuBytes + delta > TEXTURE_BUDGET_BYTES) {
            this.evictUnused(this.gpuBytes + delta - TEXTURE_BUDGET_BYTES);
            // Still too much: keep the previous texture (if any) rather than thrash.
            // Not "deferred": waiting a frame would not free anything.
            if (this.gpuBytes + delta > TEXTURE_BUDGET_BYTES) return;
        }

        const gl = this.gl;
        this.dropTexture(chunk);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Integer textures are only complete with NEAREST filtering
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const size = lodSize(lod);
        if (lod === 0) {
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, size, size);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ids);
        } else {
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
            const rgba = downsampleRegion(ids, lod, PALETTE_LUT, 0, 0, size - 1, size - 1, scratch());
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        }
        chunk.texture = texture;
        chunk.textureLod = lod;
        chunk.textureSize = size;
        chunk.clearDirty();
        this.textured.add(chunk);
        this.gpuBytes += bytes;
    }

    // Uploads pending changes: each changed texel, or their bounding rectangle
    // when that moves less data (see preferTexelUploads)
    private flush(chunk: Chunk): void {
        const ids = chunk.ids;
        if (!ids || !chunk.texture) return;
        const gl = this.gl;
        const lod = chunk.textureLod, size = chunk.textureSize;
        const x0 = chunk.dx0, y0 = chunk.dy0, x1 = chunk.dx1, y1 = chunk.dy1;
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const texels = chunk.dirtyOverflow ? null : dedupe(chunk.dirtyTexels);
        gl.bindTexture(gl.TEXTURE_2D, chunk.texture);

        if (texels && preferTexelUploads(texels.length, w * h, lod)) {
            for (const i of texels) {
                const tx = i % size, ty = (i - tx) / size;
                if (lod === 0) {
                    // At lod 0 texel index == pixel index: upload straight from the chunk buffer
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, ty, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ids, i);
                } else {
                    downsampleRegion(ids, lod, PALETTE_LUT, tx, ty, tx, ty, texel4);
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, ty, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, texel4);
                }
            }
        } else if (lod === 0) {
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, CHUNK_SIZE);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ids, y0 * CHUNK_SIZE + x0);
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        } else {
            // Recomputes only the affected cells; a rectangle spanning the whole
            // texture amounts to a full rebuild without reallocating it
            const rgba = downsampleRegion(ids, lod, PALETTE_LUT, x0, y0, x1, y1, scratch());
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        }
        chunk.clearDirty();
    }

    private dropTexture(chunk: Chunk): void {
        if (!chunk.texture) return;
        this.gl.deleteTexture(chunk.texture);
        this.gpuBytes -= textureBytes(chunk.textureLod);
        this.textured.delete(chunk);
        chunk.texture = null;
        chunk.clearDirty();
    }

    // Frees at least `bytes` from textures not drawn this frame, least recently drawn first
    private evictUnused(bytes: number): void {
        const victims = [...this.textured].filter((c) => c.lastUsedFrame !== this.frame);
        victims.sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
        let freed = 0;
        for (const chunk of victims) {
            if (freed >= bytes) break;
            freed += textureBytes(chunk.textureLod);
            this.dropTexture(chunk);
        }
    }
}
