import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, CHUNK_AREA } from '../config';
import { PALETTE_LUT } from '../palette';
import { MAX_LOD, downsampleRegion, lodSize, preferTexelUploads, selectLod, textureBytes } from './lod';

// Synthetic LUT with distinct, easy to average channels: id k -> (k, 255 - k, k / 2)
const LUT = new Uint8Array(256 * 4);
for (let k = 0; k < 256; k++) LUT.set([k, 255 - k, k >> 1, 255], k * 4);

const rgbaAt = (out: Uint8Array, w: number, x: number, y: number) => Array.from(out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

function full(ids: Uint8Array | null, lod: number, lut: Uint8Array = LUT) {
    const size = lodSize(lod);
    return downsampleRegion(ids, lod, lut, 0, 0, size - 1, size - 1, new Uint8Array(size * size * 4));
}

describe('lod math', () => {
    it('halves the texture side per level, rounding up', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(lodSize)).toEqual([500, 250, 125, 63, 32, 16, 8, 4, 2]);
    });

    it('caps the level so the smallest texture is at least 2x2', () => {
        expect(MAX_LOD).toBe(8);
        expect(lodSize(MAX_LOD)).toBeGreaterThanOrEqual(2);
        expect(lodSize(MAX_LOD + 1)).toBeLessThan(2);
    });

    it('selects one texel per device pixel or more', () => {
        expect(selectLod(50)).toBe(0);
        expect(selectLod(1)).toBe(0);
        expect(selectLod(0.75)).toBe(0);
        expect(selectLod(0.5)).toBe(1);
        expect(selectLod(0.3)).toBe(1);
        expect(selectLod(0.25)).toBe(2);
        expect(selectLod(0.1)).toBe(3);
        expect(selectLod(1e-6)).toBe(MAX_LOD);
        expect(selectLod(0)).toBe(MAX_LOD);
        expect(selectLod(-1)).toBe(MAX_LOD);
        expect(selectLod(Infinity)).toBe(0);
        expect(selectLod(NaN)).toBe(0);
    });

    it('counts 1 byte per texel at lod 0 (R8UI) and 4 above (RGBA8)', () => {
        expect(textureBytes(0)).toBe(CHUNK_AREA);
        expect(textureBytes(1)).toBe(250 * 250 * 4);
        expect(textureBytes(3)).toBe(63 * 63 * 4);
    });
});

describe('downsampleRegion', () => {
    it('renders a buffer-less chunk as empty (lut[0])', () => {
        const out = full(null, 2, PALETTE_LUT);
        expect(rgbaAt(out, 125, 0, 0)).toEqual([255, 255, 255, 255]);
        expect(rgbaAt(out, 125, 124, 124)).toEqual([255, 255, 255, 255]);
    });

    it('looks ids up through the palette: 0 is white, unknown ids are magenta', () => {
        const ids = new Uint8Array(CHUNK_AREA).fill(200); // not in the palette
        ids.fill(0, 0, CHUNK_SIZE * 2); // first two rows empty
        const out = full(ids, 1, PALETTE_LUT);
        expect(rgbaAt(out, 250, 3, 0)).toEqual([255, 255, 255, 255]);
        expect(rgbaAt(out, 250, 3, 1)).toEqual([255, 0, 255, 255]);
    });

    it('keeps a uniform color exact in every cell, edge cells included', () => {
        const ids = new Uint8Array(CHUNK_AREA).fill(77);
        for (const lod of [1, 3, 5, MAX_LOD]) {
            const size = lodSize(lod);
            const out = full(ids, lod);
            for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
                expect(rgbaAt(out, size, x, y)).toEqual([77, 178, 38, 255]);
            }
        }
    });

    it('averages each 2^lod square, rounding half up', () => {
        const ids = new Uint8Array(CHUNK_AREA);
        // Cell (0, 0) at lod 1: ids 10, 11 / 12, 15 -> r = 48 / 4 = 12, g = 972 / 4 = 243, b = 23 / 4 = 5.75 -> 6
        ids[0] = 10; ids[1] = 11; ids[CHUNK_SIZE] = 12; ids[CHUNK_SIZE + 1] = 15;
        // Cell (1, 0): ids 1, 2 / 0, 0 -> r = 3 / 4 = 0.75 -> 1, g = 1017 / 4 = 254.25 -> 254, b = 1 / 4 -> 0
        ids[2] = 1; ids[3] = 2;
        const out = full(ids, 1);
        expect(rgbaAt(out, 250, 0, 0)).toEqual([12, 243, 6, 255]);
        expect(rgbaAt(out, 250, 1, 0)).toEqual([1, 254, 0, 255]);
    });

    it('averages edge cells over their real (smaller) area', () => {
        // lod 3: 500 = 62 * 8 + 4, so the last column/row of cells covers 4 pixels
        const ids = new Uint8Array(CHUNK_AREA);
        for (let y = 0; y < 8; y++) ids.fill(100, y * CHUNK_SIZE + 496, y * CHUNK_SIZE + 500);
        for (let y = 496; y < 500; y++) ids.fill(60, y * CHUNK_SIZE + 496, y * CHUNK_SIZE + 500);
        const out = full(ids, 3);
        expect(rgbaAt(out, 63, 62, 0)).toEqual([100, 155, 50, 255]); // not diluted by missing pixels
        expect(rgbaAt(out, 63, 61, 0)).toEqual([0, 255, 0, 255]);
        expect(rgbaAt(out, 63, 62, 62)).toEqual([60, 195, 30, 255]); // 4x4 corner cell
    });

    it('produces the same cells for a sub-region as for the whole texture', () => {
        const ids = new Uint8Array(CHUNK_AREA);
        let seed = 12345;
        for (let i = 0; i < ids.length; i++) {
            seed = (seed * 1103515245 + 12345) >>> 0;
            ids[i] = seed >>> 24;
        }
        for (const lod of [1, 2, 3, 6]) {
            const size = lodSize(lod);
            const whole = full(ids, lod);
            const [tx0, ty0, tx1, ty1] = [Math.floor(size / 3), 1, size - 1, Math.min(size - 1, 5)];
            const w = tx1 - tx0 + 1, h = ty1 - ty0 + 1;
            const region = downsampleRegion(ids, lod, LUT, tx0, ty0, tx1, ty1, new Uint8Array(w * h * 4));
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) expect(rgbaAt(region, w, x, y)).toEqual(rgbaAt(whole, size, tx0 + x, ty0 + y));
            }
            const one = downsampleRegion(ids, lod, LUT, size - 1, size - 1, size - 1, size - 1, new Uint8Array(4));
            expect(Array.from(one)).toEqual(rgbaAt(whole, size, size - 1, size - 1));
        }
    });
});

describe('preferTexelUploads', () => {
    it('uploads a few scattered texels one by one', () => {
        expect(preferTexelUploads(1, 1, 0)).toBe(true);
        expect(preferTexelUploads(2, CHUNK_AREA, 0)).toBe(true);
        expect(preferTexelUploads(10, 100, 3)).toBe(true);
    });

    it('uploads the bounding rectangle when it is dense enough', () => {
        expect(preferTexelUploads(200, 400, 0)).toBe(false);
        expect(preferTexelUploads(16, 16, 0)).toBe(false);
        expect(preferTexelUploads(90, 100, 3)).toBe(false);
    });

    it('weights recomputation at coarse levels: the fewer cells touched wins', () => {
        // At lod 6 one cell costs 4096 source pixels: the call overhead no longer matters
        expect(preferTexelUploads(90, 100, 6)).toBe(true);
        expect(preferTexelUploads(100, 100, 6)).toBe(false);
    });
});
