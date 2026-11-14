import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_AREA, CHUNK_SIZE } from '../config';
import { PALETTE_LUT } from '../palette';
import type { PixelUpdate } from '../types';
import { ChunkStore } from './ChunkStore';
import { lodSize } from './lod';

// Minimal recording WebGL2 stand-in: constants evaluate to their own name,
// every method call is recorded, create* return fresh objects.
function fakeGl() {
    const calls: { name: string; args: unknown[] }[] = [];
    const state = { lost: false };
    let id = 0;
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
        isContextLost: () => state.lost,
        createTexture: () => ({ texture: ++id }),
    };
    const gl = new Proxy({}, {
        get(_target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return prop;
            return (...args: unknown[]) => {
                calls.push({ name: prop, args });
                return handlers[prop]?.(...args);
            };
        },
    }) as unknown as WebGL2RenderingContext;
    const of = (name: string) => calls.filter((c) => c.name === name);
    const reset = () => (calls.length = 0);
    return { gl, calls, state, of, reset };
}

// Chunk (10, 10) covers world pixels 5000..5499 on both axes
const CX = 10, CY = 10, X0 = CX * CHUNK_SIZE, Y0 = CY * CHUNK_SIZE;
const px = (x: number, y: number, color: number): PixelUpdate => ({ x, y, color });

function loadedStore(painted = true) {
    const fake = fakeGl();
    const store = new ChunkStore(fake.gl);
    store.beginLoad(CX, CY);
    if (painted) store.applyPixels([px(X0 + 1, Y0 + 2, 6)]);
    store.finishLoad(CX, CY);
    return { store, ...fake };
}

afterEach(() => vi.restoreAllMocks());

describe('ChunkStore data plane', () => {
    it('walks unloaded -> loading -> loaded -> unloaded', () => {
        const store = new ChunkStore(fakeGl().gl);
        expect(store.state(CX, CY)).toBe('unloaded');
        store.finishLoad(CX, CY); // only from 'loading'
        expect(store.state(CX, CY)).toBe('unloaded');
        store.beginLoad(CX, CY);
        expect(store.state(CX, CY)).toBe('loading');
        store.finishLoad(CX, CY);
        expect(store.state(CX, CY)).toBe('loaded');
        store.finishLoad(CX, CY);
        expect(store.state(CX, CY)).toBe('loaded');
        store.evict(CX, CY);
        expect(store.state(CX, CY)).toBe('unloaded');
        expect(store.stats()).toMatchObject({ loaded: 0, loading: 0, withData: 0, cpuBytes: 0 });
    });

    it('ignores chunk coordinates outside the grid (no key aliasing)', () => {
        const store = new ChunkStore(fakeGl().gl);
        store.beginLoad(20, 0); // would alias chunk (0, 1) with a naive key
        store.beginLoad(-1, 3);
        store.beginLoad(1.5, 3);
        expect(store.state(0, 1)).toBe('unloaded');
        expect(store.state(20, 0)).toBe('unloaded');
        expect(store.stats().loading).toBe(0);
    });

    it('allocates a chunk buffer only on the first non-zero write', () => {
        const store = new ChunkStore(fakeGl().gl);
        store.beginLoad(CX, CY);
        expect(store.applyPixels([px(X0, Y0, 0), px(X0 + 7, Y0 + 9, 0)])).toBe(false);
        expect(store.stats()).toMatchObject({ loading: 1, withData: 0, cpuBytes: 0 });
        expect(store.applyPixels([px(X0 + 7, Y0 + 9, 3)])).toBe(true);
        expect(store.stats()).toMatchObject({ withData: 1, cpuBytes: CHUNK_AREA });
        // Same value again: nothing changes
        expect(store.applyPixels([px(X0 + 7, Y0 + 9, 3)])).toBe(false);
        // Erasing keeps the buffer
        expect(store.applyPixels([px(X0 + 7, Y0 + 9, 0)])).toBe(true);
        expect(store.stats().withData).toBe(1);
    });

    it('ignores unloaded chunks, out-of-grid coordinates and invalid ids', () => {
        const store = new ChunkStore(fakeGl().gl);
        store.beginLoad(CX, CY);
        const changed = store.applyPixels([
            px(0, 0, 5),             // chunk (0, 0) not loaded
            px(-1, Y0, 5),
            px(10_000, Y0, 5),
            px(X0 + 0.5, Y0, 5),
            px(X0, Y0, 256),
            px(X0, Y0, -1),
            px(X0, Y0, 2.5),
            px(X0, Y0, NaN),
        ]);
        expect(changed).toBe(false);
        expect(store.stats()).toMatchObject({ loading: 1, loaded: 0, withData: 0 });
        expect(store.state(0, 0)).toBe('unloaded');
    });

    it('reports pixels only once the chunk is fully loaded', () => {
        const store = new ChunkStore(fakeGl().gl);
        expect(store.getPixel(X0, Y0)).toBeNull();
        store.beginLoad(CX, CY);
        store.applyPixels([px(X0 + 3, Y0 + 4, 9)]);
        expect(store.getPixel(X0 + 3, Y0 + 4)).toBeNull(); // still loading: unknown
        store.finishLoad(CX, CY);
        expect(store.getPixel(X0 + 3, Y0 + 4)).toBe(9);
        expect(store.getPixel(X0 + 499, Y0 + 499)).toBe(0);
        expect(store.getPixel(-1, 0)).toBeNull();
        expect(store.getPixel(10_000, 0)).toBeNull();

        // Loaded without any painted pixel: known empty
        store.beginLoad(0, 0);
        store.finishLoad(0, 0);
        expect(store.getPixel(5, 5)).toBe(0);
        expect(store.stats()).toMatchObject({ loaded: 2, withData: 1 });
    });

    it('discards previous data when a chunk starts loading again', () => {
        const store = new ChunkStore(fakeGl().gl);
        store.beginLoad(CX, CY);
        store.applyPixels([px(X0, Y0, 4)]);
        store.finishLoad(CX, CY);
        store.beginLoad(CX, CY);
        expect(store.state(CX, CY)).toBe('loading');
        expect(store.stats().withData).toBe(0);
        store.finishLoad(CX, CY);
        expect(store.getPixel(X0, Y0)).toBe(0);
    });

    it('applies large batches spread over several chunks', () => {
        const store = new ChunkStore(fakeGl().gl);
        for (let cx = 0; cx < 4; cx++) store.beginLoad(cx, 0);
        const updates: PixelUpdate[] = [];
        for (let i = 0; i < 5000; i++) updates.push(px((i * 7) % 2000, (i * 13) % CHUNK_SIZE, 1 + (i % 16)));
        expect(store.applyPixels(updates)).toBe(true);
        for (let cx = 0; cx < 4; cx++) store.finishLoad(cx, 0);
        expect(store.stats()).toMatchObject({ loaded: 4, withData: 4 });
        for (const u of updates.slice(-50)) expect(store.getPixel(u.x, u.y)).toBe(u.color);
    });
});

describe('ChunkStore GPU plane', () => {
    it('builds an R8UI texture of raw ids at lod 0', () => {
        const { store, of } = loadedStore();
        const drawn = store.prepareVisible(CX, CY, CX, CY, 0);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]).toMatchObject({ cx: CX, cy: CY, loading: false, textureLod: 0 });
        expect(drawn[0].texture).not.toBeNull();
        expect(of('texStorage2D')[0].args).toEqual(['TEXTURE_2D', 1, 'R8UI', 500, 500]);
        const upload = of('texSubImage2D')[0].args;
        expect(upload.slice(0, 8)).toEqual(['TEXTURE_2D', 0, 0, 0, 500, 500, 'RED_INTEGER', 'UNSIGNED_BYTE']);
        expect((upload[8] as Uint8Array)[2 * CHUNK_SIZE + 1]).toBe(6);
        expect(of('texParameteri').map((c) => c.args[2])).toEqual(['NEAREST', 'NEAREST', 'CLAMP_TO_EDGE', 'CLAMP_TO_EDGE']);
        expect(store.stats()).toMatchObject({ textures: 1, gpuBytes: CHUNK_AREA });
        expect(store.hasDeferredWork).toBe(false);
    });

    it('draws a loaded chunk without data as a texture-less (white) quad', () => {
        const { store, of } = loadedStore(false);
        const drawn = store.prepareVisible(CX, CY, CX, CY, 0);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].texture).toBeNull();
        expect(of('createTexture')).toHaveLength(0);
    });

    it('draws a loading chunk at lod 0 only, and nothing for empty or unloaded chunks', () => {
        const { gl, of } = fakeGl();
        const store = new ChunkStore(gl);
        store.beginLoad(CX, CY);
        store.applyPixels([px(X0, Y0, 2)]);
        store.beginLoad(CX + 1, CY); // loading, no data yet
        expect(store.prepareVisible(CX - 1, CY - 1, CX + 1, CY + 1, 1)).toHaveLength(0);
        expect(of('createTexture')).toHaveLength(0);
        const drawn = store.prepareVisible(CX - 1, CY - 1, CX + 1, CY + 1, 0);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]).toMatchObject({ cx: CX, cy: CY, loading: true, textureLod: 0 });
        // Finishing the load keeps the same texture: only the shader mode changes
        const texture = drawn[0].texture;
        store.finishLoad(CX, CY);
        const after = store.prepareVisible(CX, CY, CX, CY, 0);
        expect(after[0]).toMatchObject({ loading: false, texture });
        expect(of('createTexture')).toHaveLength(1);
    });

    it('uploads a few live changes texel by texel, straight from the chunk buffer', () => {
        const { store, of, reset } = loadedStore();
        store.prepareVisible(CX, CY, CX, CY, 0);
        reset();
        store.applyPixels([px(X0 + 10, Y0 + 20, 3), px(X0 + 400, Y0 + 300, 4)]);
        store.prepareVisible(CX, CY, CX, CY, 0);
        const uploads = of('texSubImage2D').map((c) => c.args);
        expect(uploads).toHaveLength(2);
        expect(uploads[0].slice(0, 8)).toEqual(['TEXTURE_2D', 0, 10, 20, 1, 1, 'RED_INTEGER', 'UNSIGNED_BYTE']);
        expect(uploads[0][9]).toBe(20 * CHUNK_SIZE + 10); // srcOffset into the ids buffer
        expect(uploads[1].slice(2, 6)).toEqual([400, 300, 1, 1]);
        expect(of('texStorage2D')).toHaveLength(0);
        expect(of('pixelStorei').filter((c) => c.args[0] === 'UNPACK_ROW_LENGTH')).toHaveLength(0);
    });

    it('uploads the dirty rectangle when changes are dense', () => {
        const { store, of, reset } = loadedStore();
        store.prepareVisible(CX, CY, CX, CY, 0);
        reset();
        const updates: PixelUpdate[] = [];
        for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) updates.push(px(X0 + 50 + x, Y0 + 60 + y, 7));
        store.applyPixels(updates);
        store.prepareVisible(CX, CY, CX, CY, 0);
        const uploads = of('texSubImage2D').map((c) => c.args);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].slice(2, 6)).toEqual([50, 60, 10, 10]);
        expect(uploads[0][9]).toBe(60 * CHUNK_SIZE + 50);
        expect(of('pixelStorei').map((c) => c.args)).toEqual([
            ['UNPACK_ALIGNMENT', 1],
            ['UNPACK_ROW_LENGTH', CHUNK_SIZE],
            ['UNPACK_ROW_LENGTH', 0],
        ]);
    });

    it('rebuilds at a new level of detail as a downsampled RGBA8 texture', () => {
        const { store, of, reset } = loadedStore();
        const first = store.prepareVisible(CX, CY, CX, CY, 0)[0].texture;
        reset();
        const drawn = store.prepareVisible(CX, CY, CX, CY, 2);
        expect(drawn[0].textureLod).toBe(2);
        expect(of('deleteTexture')[0].args[0]).toBe(first);
        expect(of('texStorage2D')[0].args).toEqual(['TEXTURE_2D', 1, 'RGBA8', 125, 125]);
        const upload = of('texSubImage2D')[0].args;
        expect(upload.slice(0, 8)).toEqual(['TEXTURE_2D', 0, 0, 0, 125, 125, 'RGBA', 'UNSIGNED_BYTE']);
        expect(store.stats().gpuBytes).toBe(125 * 125 * 4);
    });

    it('recomputes only the affected cell on a live change at lod >= 1', () => {
        const { store, of, reset } = loadedStore(false);
        store.applyPixels([px(X0, Y0, 1)]); // allocate the buffer (white = id 1)
        store.prepareVisible(CX, CY, CX, CY, 1);
        reset();
        // 4 = Noir (#222222): one of the 4 pixels of cell (5, 7) at lod 1
        store.applyPixels([px(X0 + 11, Y0 + 15, 4)]);
        store.prepareVisible(CX, CY, CX, CY, 1);
        const uploads = of('texSubImage2D').map((c) => c.args);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].slice(0, 8)).toEqual(['TEXTURE_2D', 0, 5, 7, 1, 1, 'RGBA', 'UNSIGNED_BYTE']);
        const black = PALETTE_LUT[4 * 4];
        const expected = Math.floor((255 * 3 + black + 2) / 4);
        expect(Array.from(uploads[0][8] as Uint8Array)).toEqual([expected, expected, expected, 255]);
    });

    it('re-downsamples the dirty region when many cells changed at lod >= 1', () => {
        const { store, of, reset } = loadedStore();
        store.prepareVisible(CX, CY, CX, CY, 3);
        reset();
        const updates: PixelUpdate[] = [];
        for (let i = 0; i < 400; i++) updates.push(px(X0 + (i % 20) * 8, Y0 + Math.floor(i / 20) * 8, 5));
        store.applyPixels(updates);
        store.prepareVisible(CX, CY, CX, CY, 3);
        const uploads = of('texSubImage2D').map((c) => c.args);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].slice(2, 6)).toEqual([0, 0, 20, 20]);
        expect(of('texStorage2D')).toHaveLength(0); // same texture, patched in place
        expect(lodSize(3)).toBe(63);
    });

    it('spreads texture builds over frames with a time budget, nearest first', () => {
        const { gl } = fakeGl();
        const store = new ChunkStore(gl);
        for (let cx = 0; cx < 3; cx++) {
            store.beginLoad(cx, 0);
            store.applyPixels([px(cx * CHUNK_SIZE, 0, 2)]);
            store.finishLoad(cx, 0);
        }
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => (now += 10)); // every build "takes" 10 ms
        const frame1 = store.prepareVisible(0, 0, 2, 0, 0, 2.5 * CHUNK_SIZE, 0);
        expect(frame1.map((c) => c.cx)).toEqual([2]); // closest to the focus point
        expect(store.hasDeferredWork).toBe(true);
        expect(store.prepareVisible(0, 0, 2, 0, 0, 2.5 * CHUNK_SIZE, 0).map((c) => c.cx).sort()).toEqual([1, 2]);
        expect(store.prepareVisible(0, 0, 2, 0, 0, 2.5 * CHUNK_SIZE, 0)).toHaveLength(3);
        expect(store.hasDeferredWork).toBe(false);
    });

    it('keeps drawing the previous texture while a rebuild is deferred', () => {
        const { gl } = fakeGl();
        const store = new ChunkStore(gl);
        for (let cx = 0; cx < 2; cx++) {
            store.beginLoad(cx, 0);
            store.applyPixels([px(cx * CHUNK_SIZE, 0, 2)]);
            store.finishLoad(cx, 0);
        }
        store.prepareVisible(0, 0, 1, 0, 0);
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => (now += 10));
        const drawn = store.prepareVisible(0, 0, 1, 0, 2);
        expect(drawn.map((c) => c.textureLod).sort()).toEqual([0, 2]);
        expect(store.hasDeferredWork).toBe(true);
    });

    it('frees textures on beginLoad and evict', () => {
        const { store, of } = loadedStore();
        const texture = store.prepareVisible(CX, CY, CX, CY, 0)[0].texture;
        store.beginLoad(CX, CY);
        expect(of('deleteTexture').map((c) => c.args[0])).toEqual([texture]);
        expect(store.stats()).toMatchObject({ textures: 0, gpuBytes: 0 });
        store.applyPixels([px(X0, Y0, 3)]);
        const second = store.prepareVisible(CX, CY, CX, CY, 0)[0].texture;
        store.evict(CX, CY);
        expect(of('deleteTexture').map((c) => c.args[0])).toEqual([texture, second]);
        expect(store.stats()).toMatchObject({ textures: 0, gpuBytes: 0, loading: 0, loaded: 0 });
    });

    it('forgets textures on restore() and rebuilds them on demand', () => {
        const { store, of } = loadedStore();
        store.prepareVisible(CX, CY, CX, CY, 0);
        store.restore();
        expect(of('deleteTexture')).toHaveLength(0); // already gone with the lost context
        expect(store.stats()).toMatchObject({ textures: 0, gpuBytes: 0, withData: 1 });
        store.prepareVisible(CX, CY, CX, CY, 0);
        expect(of('createTexture')).toHaveLength(2);
        expect(store.stats().textures).toBe(1);
    });

    it('does nothing while the context is lost', () => {
        const { store, state, of } = loadedStore();
        state.lost = true;
        expect(store.prepareVisible(CX, CY, CX, CY, 0)).toHaveLength(0);
        expect(of('createTexture')).toHaveLength(0);
    });

    it('deletes everything on dispose()', () => {
        const { store, of } = loadedStore();
        store.prepareVisible(CX, CY, CX, CY, 0);
        store.dispose();
        expect(of('deleteTexture')).toHaveLength(1);
        expect(store.stats()).toEqual({ loaded: 0, loading: 0, withData: 0, cpuBytes: 0, gpuBytes: 0, textures: 0 });
    });
});
