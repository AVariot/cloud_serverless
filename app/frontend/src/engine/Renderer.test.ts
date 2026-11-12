import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../config';
import { PALETTE_LUT } from '../palette';
import { Camera } from './Camera';
import { ChunkStore } from './ChunkStore';
import { OverlayBuffer, OverlayStyle } from './overlay';
import { Renderer } from './Renderer';

// Recording WebGL2 stand-in: constants evaluate to their own name, uniform
// locations are { name }, create* return fresh objects, shaders always compile
// unless a handler says otherwise.
function fakeGl() {
    const calls: { name: string; args: unknown[] }[] = [];
    const state = { lost: false };
    let id = 0;
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
        isContextLost: () => state.lost,
        createShader: () => ({ shader: ++id }),
        createProgram: () => ({ program: ++id }),
        createBuffer: () => ({ buffer: ++id }),
        createVertexArray: () => ({ vao: ++id }),
        createTexture: () => ({ texture: ++id }),
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getUniformLocation: (_program, name) => ({ name }),
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
    const uniform = (fn: string, name: string) =>
        of(fn).filter((c) => (c.args[0] as { name: string } | null)?.name === name).map((c) => c.args.slice(1));
    const reset = () => (calls.length = 0);
    return { gl, handlers, state, of, uniform, reset };
}

function setup() {
    const fake = fakeGl();
    const renderer = new Renderer(fake.gl);
    renderer.init();
    renderer.setViewport(800, 600);
    const chunks = new ChunkStore(fake.gl);
    const camera = new Camera();
    camera.setViewport(800, 600);
    camera.x = 5000.25; // chunks 9..10 on both axes are visible
    camera.y = 5000.25;
    camera.zoom = 1;
    return { ...fake, renderer, chunks, camera };
}

function load(chunks: ChunkStore, cx: number, cy: number, painted: boolean, finish = true) {
    chunks.beginLoad(cx, cy);
    if (painted) chunks.applyPixels([{ x: cx * CHUNK_SIZE + 1, y: cy * CHUNK_SIZE + 1, color: 5 }]);
    if (finish) chunks.finishLoad(cx, cy);
}

describe('Renderer', () => {
    it('compiles four programs and pins every sampler to its own texture unit', () => {
        const { of, uniform } = setup();
        expect(of('linkProgram')).toHaveLength(4);
        expect(uniform('uniform1i', 'u_ids')).toEqual([[0]]);
        expect(uniform('uniform1i', 'u_palette')).toEqual([[1], [1]]);
        expect(uniform('uniform1i', 'u_colors')).toEqual([[2]]);
        expect(of('texStorage2D')[0].args).toEqual(['TEXTURE_2D', 1, 'RGBA8', 256, 1]);
        expect(of('texSubImage2D')[0].args[8]).toBe(PALETTE_LUT);
        expect(of('vertexAttribDivisor')[0].args).toEqual([1, 1]);
    });

    it('throws a readable error when a shader does not compile', () => {
        const { gl, handlers } = fakeGl();
        handlers.getShaderParameter = () => false;
        handlers.getShaderInfoLog = () => "ERROR: 0:12: 'half' : reserved word";
        expect(() => new Renderer(gl).init()).toThrow(/quad vertex shader compile failed: ERROR: 0:12/);
    });

    it('throws a readable error when a program does not link', () => {
        const { gl, handlers, of } = fakeGl();
        handlers.getProgramParameter = () => false;
        handlers.getProgramInfoLog = () => 'varying mismatch';
        expect(() => new Renderer(gl).init()).toThrow(/program "quad" link failed: varying mismatch/);
        expect(of('deleteProgram')).toHaveLength(1);
    });

    it('stays silent while the context is lost', () => {
        const { gl, state, of } = fakeGl();
        state.lost = true;
        const renderer = new Renderer(gl);
        expect(() => renderer.init()).not.toThrow();
        const camera = new Camera();
        camera.setViewport(800, 600);
        renderer.render(camera, new ChunkStore(gl), []);
        expect(of('drawArrays')).toHaveLength(0);
        expect(renderer.stats.drawCalls).toBe(0);
    });

    it('draws background, white, id and loading chunks, then one call per non-empty layer', () => {
        const { renderer, chunks, camera, of, uniform, reset } = setup();
        load(chunks, 9, 9, false);         // loaded, nothing painted: white quad
        load(chunks, 10, 10, true);        // loaded with data: ids
        load(chunks, 9, 10, true, false);  // loading with data: ids, empties shown as unloaded
        // (10, 9) unloaded: nothing
        const cursor = new OverlayBuffer('cursor');
        cursor.push(5000, 5000, 3, OverlayStyle.PREVIEW);
        cursor.push(5000, 5000, 0, OverlayStyle.SELECTION);
        const empty = new OverlayBuffer('pending');
        reset();

        renderer.render(camera, chunks, [empty, cursor]);

        expect(of('drawArrays')).toHaveLength(4); // background + white + 2 id chunks
        expect(of('drawArraysInstanced').map((c) => c.args)).toEqual([['TRIANGLE_STRIP', 0, 4, 2]]);
        expect(renderer.stats.drawCalls).toBe(5);
        // Background over the visible pixels, then the white chunk, then id chunks (row by row)
        expect(uniform('uniform2i', 'u_origin')).toEqual([[4600, 4700], [4500, 4500], [4500, 5000], [5000, 5000]]);
        expect(uniform('uniform2i', 'u_size')).toEqual([[801, 601], [500, 500], [500, 500], [500, 500]]);
        expect(uniform('uniform1i', 'u_white')).toEqual([[0], [1]]);
        expect(uniform('uniform1i', 'u_loading')).toEqual([[1], [0]]);
        expect(uniform('uniform2i', 'u_camInt')[0]).toEqual([5000, 5000]);
        expect(uniform('uniform2f', 'u_camFrac')[0]).toEqual([0.25, 0.25]);
        expect(of('enable').map((c) => c.args[0])).toEqual(['BLEND']);
        expect(renderer.hasDeferredWork).toBe(false);
    });

    it('re-uploads a layer only when its content changed', () => {
        const { renderer, chunks, camera, of, reset } = setup();
        const layer = new OverlayBuffer('cursor');
        layer.push(1, 2, 3, OverlayStyle.BRUSH);
        reset();
        renderer.render(camera, chunks, [layer]);
        expect(of('bufferData').map((c) => c.args)).toEqual([['ARRAY_BUFFER', 4096, 'DYNAMIC_DRAW']]);
        expect(of('bufferSubData').map((c) => c.args)).toEqual([['ARRAY_BUFFER', 0, layer.data, 0, 4]]);
        renderer.render(camera, chunks, [layer]);
        expect(of('bufferSubData')).toHaveLength(1);
        layer.push(2, 2, 3, OverlayStyle.BRUSH);
        renderer.render(camera, chunks, [layer]);
        expect(of('bufferSubData')).toHaveLength(2);
        // A different buffer object under the same id is uploaded even if versions match
        const twin = new OverlayBuffer('cursor');
        twin.push(9, 9, 1, OverlayStyle.HOVER);
        twin.push(9, 9, 1, OverlayStyle.HOVER);
        renderer.render(camera, chunks, [twin]);
        expect(of('bufferSubData')).toHaveLength(3);
        expect(of('createBuffer')).toHaveLength(1);
    });

    it('forgets layer buffers on init() after a context restore', () => {
        const { renderer, chunks, camera, of, reset } = setup();
        const layer = new OverlayBuffer('cursor');
        layer.push(1, 2, 3, OverlayStyle.HOVER);
        renderer.render(camera, chunks, [layer]);
        reset();
        renderer.init();
        renderer.render(camera, chunks, [layer]);
        expect(of('createBuffer')).toHaveLength(2); // quad VBO + the layer again
        expect(of('bufferSubData')).toHaveLength(1);
        expect(of('deleteBuffer')).toHaveLength(0);
        expect(of('viewport').map((c) => c.args)).toEqual([[0, 0, 800, 600]]);
    });

    it('draws downsampled chunks when zoomed out, and skips loading ones', () => {
        const { renderer, chunks, camera, of, uniform, reset } = setup();
        camera.zoom = 0.2; // 0.2 device px per world px -> lod 2
        load(chunks, 10, 10, true);
        load(chunks, 9, 10, true, false);
        reset();
        renderer.render(camera, chunks, []);
        expect(of('texStorage2D').map((c) => c.args)).toEqual([['TEXTURE_2D', 1, 'RGBA8', 125, 125]]);
        expect(uniform('uniform1i', 'u_lodShift')).toEqual([[2]]);
        expect(of('drawArrays')).toHaveLength(2); // background + the loaded chunk
        expect(of('activeTexture').map((c) => c.args[0])).toEqual(['TEXTURE01', 'TEXTURE03', 'TEXTURE02']);
    });

    it('releases its GL objects on dispose()', () => {
        const { renderer, chunks, camera, of } = setup();
        const layer = new OverlayBuffer('cursor');
        layer.push(1, 2, 3, OverlayStyle.HOVER);
        renderer.render(camera, chunks, [layer]);
        renderer.dispose();
        expect(of('deleteProgram')).toHaveLength(4);
        expect(of('deleteVertexArray')).toHaveLength(2);
        expect(of('deleteBuffer')).toHaveLength(2);
        expect(of('deleteTexture')).toHaveLength(1);
        renderer.render(camera, chunks, [layer]); // no-op after dispose
        expect(renderer.stats.drawCalls).toBe(0);
    });
});
