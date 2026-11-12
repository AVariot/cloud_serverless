// Pure CPU helpers for chunk textures: level-of-detail math, palette-id
// downsampling and the upload strategy. No WebGL here so it is unit-testable.
import { CHUNK_SIZE } from '../config';

/** Side of a chunk texture at a level of detail (each level halves the resolution) */
export const lodSize = (lod: number) => Math.ceil(CHUNK_SIZE / 2 ** lod);

/** Coarsest level whose texture is still at least 2x2 texels (8 for 500 px chunks) */
export const MAX_LOD = (() => {
    let lod = 0;
    while (lodSize(lod + 1) >= 2) lod++;
    return lod;
})();

/**
 * Level of detail matching the on-screen size: one texel per device pixel or more.
 * lod = max(0, floor(-log2(devicePxPerWorldPx))), capped at MAX_LOD.
 */
export function selectLod(devicePxPerWorldPx: number): number {
    if (Number.isNaN(devicePxPerWorldPx)) return 0;
    if (devicePxPerWorldPx <= 0) return MAX_LOD;
    return Math.min(MAX_LOD, Math.max(0, Math.floor(-Math.log2(devicePxPerWorldPx))));
}

/** GPU bytes of a chunk texture: R8UI ids (1 byte) at lod 0, RGBA8 colors above */
export const textureBytes = (lod: number) => (lod === 0 ? CHUNK_SIZE * CHUNK_SIZE : lodSize(lod) ** 2 * 4);

// A texSubImage2D call costs roughly as much as moving this many texels
// (driver validation + command overhead), measured coarsely in Chrome.
export const TEXEL_CALL_COST = 64;

/**
 * Upload strategy for the changes of one texture: true = one 1x1 upload per
 * changed texel, false = a single upload of their bounding rectangle.
 * At lod >= 1 each uploaded texel also costs 4^lod source pixels to recompute,
 * so the rectangle only wins when it holds few unchanged texels.
 */
export function preferTexelUploads(texelCount: number, rectArea: number, lod: number): boolean {
    const compute = lod === 0 ? 0 : 4 ** lod; // lod 0 uploads raw ids straight from the chunk buffer
    // Ties go to texel uploads: no UNPACK_ROW_LENGTH round trip
    return texelCount * (TEXEL_CALL_COST + compute + 1) <= TEXEL_CALL_COST + rectArea * (compute + 1);
}

// Per-cell RGB sums, reused across calls (one full lod-1 chunk = 187 500 cells x 3)
let sums = new Uint32Array(0);

/**
 * Box-filters a rectangle of cells of a chunk at `lod` into `out` (RGBA8,
 * tightly packed, (tx1-tx0+1) x (ty1-ty0+1) texels, starting at offset 0).
 * Each cell is the average color of its 2^lod x 2^lod source pixels looked up
 * through `lut` (256 x RGBA); edge cells cover fewer pixels and average only
 * those. `ids === null` means an all-empty chunk. Cell range is inclusive.
 */
export function downsampleRegion(
    ids: Uint8Array | null,
    lod: number,
    lut: Uint8Array,
    tx0: number,
    ty0: number,
    tx1: number,
    ty1: number,
    out: Uint8Array,
): Uint8Array {
    const step = 1 << lod;
    const w = tx1 - tx0 + 1;
    const h = ty1 - ty0 + 1;
    const x0 = tx0 << lod;
    const x1 = Math.min((tx1 + 1) << lod, CHUNK_SIZE); // exclusive
    const y0 = ty0 << lod;
    const y1 = Math.min((ty1 + 1) << lod, CHUNK_SIZE);

    if (!ids) {
        for (let i = 0, n = w * h * 4; i < n; i += 4) {
            out[i] = lut[0]; out[i + 1] = lut[1]; out[i + 2] = lut[2]; out[i + 3] = 255;
        }
        return out;
    }

    const cells = w * h * 3;
    if (sums.length < cells) sums = new Uint32Array(cells);
    sums.fill(0, 0, cells);

    for (let y = y0; y < y1; y++) {
        const rowSums = ((y >> lod) - ty0) * w * 3;
        let o = y * CHUNK_SIZE + x0;
        const rowEnd = y * CHUNK_SIZE + x1;
        // Accumulate one cell span in locals, then touch the sums once per span
        for (let s = rowSums; o < rowEnd; s += 3) {
            const end = Math.min(o + step, rowEnd);
            let r = 0, g = 0, b = 0;
            for (; o < end; o++) {
                const k = ids[o] << 2;
                r += lut[k]; g += lut[k + 1]; b += lut[k + 2];
            }
            sums[s] += r; sums[s + 1] += g; sums[s + 2] += b;
        }
    }

    for (let cy = 0; cy < h; cy++) {
        const ch = Math.min(step, CHUNK_SIZE - ((ty0 + cy) << lod));
        for (let cx = 0; cx < w; cx++) {
            const n = Math.min(step, CHUNK_SIZE - ((tx0 + cx) << lod)) * ch;
            const half = n >> 1; // round half up instead of truncating
            const s = (cy * w + cx) * 3, o = (cy * w + cx) * 4;
            out[o] = (sums[s] + half) / n;
            out[o + 1] = (sums[s + 1] + half) / n;
            out[o + 2] = (sums[s + 2] + half) / n;
            out[o + 3] = 255;
        }
    }
    return out;
}
