import { CHUNK_SIZE } from '../config';
import { PALETTE_LUT } from '../palette';
import type { Camera } from './Camera';
import type { ChunkStore, DrawableChunk } from './ChunkStore';
import { selectLod } from './lod';
import { OVERLAY_STRIDE, type OverlayBuffer } from './overlay';
import {
    CHUNK_VERTEX_SHADER,
    IDS_FRAGMENT_SHADER,
    OVERLAY_FRAGMENT_SHADER,
    OVERLAY_VERTEX_SHADER,
    QUAD_FRAGMENT_SHADER,
    RGBA_FRAGMENT_SHADER,
} from './shaders';

const CLEAR_COLOR = [0.05, 0.05, 0.08] as const; // outside the grid
const SELECTION_RING_CSS_PX = 1.5;

// Texture units. Each unit only ever holds one texture type, so no draw can
// find a texture that does not match its sampler type (R8UI needs a usampler).
// ChunkStore uploads through UPLOAD_TEXTURE_UNIT (3), never sampled.
const IDS_UNIT = 0;     // R8UI chunk ids     -> usampler2D u_ids
const PALETTE_UNIT = 1; // RGBA8 256x1        -> sampler2D u_palette
const COLORS_UNIT = 2;  // RGBA8 lod >= 1     -> sampler2D u_colors

// Fixed attribute locations (layout qualifiers in the shaders)
const A_CORNER = 0;
const A_INSTANCE = 1;

const VIEW_UNIFORMS = ['u_resolution', 'u_camInt', 'u_camFrac', 'u_zoom', 'u_dpr'] as const;
const CHUNK_UNIFORMS = [...VIEW_UNIFORMS, 'u_origin', 'u_size'] as const;
const QUAD_UNIFORMS = [...CHUNK_UNIFORMS, 'u_white'] as const;
const IDS_UNIFORMS = [...CHUNK_UNIFORMS, 'u_ids', 'u_palette', 'u_loading'] as const;
const RGBA_UNIFORMS = [...CHUNK_UNIFORMS, 'u_colors', 'u_lodShift'] as const;
const OVERLAY_UNIFORMS = [...VIEW_UNIFORMS, 'u_ring', 'u_palette'] as const;

type ViewUniform = (typeof VIEW_UNIFORMS)[number];
type ChunkUniform = (typeof CHUNK_UNIFORMS)[number];

interface ProgramInfo<N extends string> {
    program: WebGLProgram;
    u: Record<N, WebGLUniformLocation | null>;
}

interface LayerGL {
    buffer: WebGLBuffer;
    capacity: number;              // bytes allocated
    source: OverlayBuffer | null;  // uploaded content: this buffer at this version
    version: number;
}

interface GLObjects {
    quad: ProgramInfo<(typeof QUAD_UNIFORMS)[number]>;
    ids: ProgramInfo<(typeof IDS_UNIFORMS)[number]>;
    rgba: ProgramInfo<(typeof RGBA_UNIFORMS)[number]>;
    overlay: ProgramInfo<(typeof OVERLAY_UNIFORMS)[number]>;
    quadVbo: WebGLBuffer;
    quadVao: WebGLVertexArrayObject;
    overlayVao: WebGLVertexArrayObject;
    palette: WebGLTexture;
}

export interface RenderStats {
    drawCalls: number;
    cpuMs: number; // CPU time of render(), texture builds included (GPU time is not measured)
}

// Owns every GL object except chunk textures (ChunkStore). Passes:
// 1. clear (outside the grid)  2. "unloaded" pattern over the visible grid
// 3. visible chunks (white / palette ids / downsampled)  4. overlay layers
export class Renderer {
    private readonly gl: WebGL2RenderingContext;
    private objects: GLObjects | null = null;
    private readonly layerBuffers = new Map<string, LayerGL>();
    private deviceWidth = 0;
    private deviceHeight = 0;
    private deferred = false;
    readonly stats: RenderStats = { drawCalls: 0, cpuMs: 0 };

    // Per-frame view parameters, shared by every program
    private camX = 0;
    private camY = 0;
    private camFracX = 0;
    private camFracY = 0;
    private zoom = 1;
    private dpr = 1;
    private cssWidth = 1;
    private cssHeight = 1;

    constructor(gl: WebGL2RenderingContext) {
        this.gl = gl;
    }

    /** True when visible chunk textures still wait (time budget): request another frame */
    get hasDeferredWork(): boolean {
        return this.deferred;
    }

    /**
     * Compiles programs and creates buffers, VAOs and the palette texture.
     * Called at startup and after webglcontextrestored: objects of the lost
     * context are already gone, so previous references are simply forgotten.
     * Throws when a shader fails to compile or link (unless the context is lost).
     */
    init(): void {
        const gl = this.gl;
        this.objects = null;
        this.layerBuffers.clear();
        if (gl.isContextLost()) return; // init() runs again on restore

        const created: WebGLProgram[] = [];
        try {
            const quad = this.link('quad', CHUNK_VERTEX_SHADER, QUAD_FRAGMENT_SHADER, QUAD_UNIFORMS, created);
            const ids = this.link('ids', CHUNK_VERTEX_SHADER, IDS_FRAGMENT_SHADER, IDS_UNIFORMS, created);
            const rgba = this.link('rgba', CHUNK_VERTEX_SHADER, RGBA_FRAGMENT_SHADER, RGBA_UNIFORMS, created);
            const overlay = this.link('overlay', OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER, OVERLAY_UNIFORMS, created);

            // Samplers read fixed units for the lifetime of the programs. Set
            // explicitly: they default to unit 0, the R8UI unit.
            gl.useProgram(ids.program);
            gl.uniform1i(ids.u.u_ids, IDS_UNIT);
            gl.uniform1i(ids.u.u_palette, PALETTE_UNIT);
            gl.useProgram(rgba.program);
            gl.uniform1i(rgba.u.u_colors, COLORS_UNIT);
            gl.useProgram(overlay.program);
            gl.uniform1i(overlay.u.u_palette, PALETTE_UNIT);

            const quadVbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

            const quadVao = gl.createVertexArray();
            gl.bindVertexArray(quadVao);
            gl.enableVertexAttribArray(A_CORNER);
            gl.vertexAttribPointer(A_CORNER, 2, gl.FLOAT, false, 0, 0);

            // Same corners + one vec4 per instance; the instance buffer is
            // pointed at per layer when drawing
            const overlayVao = gl.createVertexArray();
            gl.bindVertexArray(overlayVao);
            gl.enableVertexAttribArray(A_CORNER);
            gl.vertexAttribPointer(A_CORNER, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(A_INSTANCE);
            gl.vertexAttribDivisor(A_INSTANCE, 1);
            gl.bindVertexArray(null);

            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            const palette = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0 + PALETTE_UNIT);
            gl.bindTexture(gl.TEXTURE_2D, palette);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 1);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, PALETTE_LUT);

            gl.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], 1);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.disable(gl.BLEND);
            // Straight alpha for color; alpha kept opaque even on an alpha: true canvas
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            if (this.deviceWidth > 0) gl.viewport(0, 0, this.deviceWidth, this.deviceHeight);

            this.objects = { quad, ids, rgba, overlay, quadVbo, quadVao, overlayVao, palette };
        } catch (e) {
            for (const program of created) gl.deleteProgram(program);
            throw e;
        }
    }

    setViewport(deviceWidth: number, deviceHeight: number): void {
        this.deviceWidth = deviceWidth;
        this.deviceHeight = deviceHeight;
        if (!this.gl.isContextLost()) this.gl.viewport(0, 0, deviceWidth, deviceHeight);
    }

    render(camera: Camera, chunks: ChunkStore, layers: readonly OverlayBuffer[]): void {
        const gl = this.gl;
        const o = this.objects;
        this.stats.drawCalls = 0;
        this.deferred = false;
        if (!o || gl.isContextLost()) return;
        const start = performance.now();

        gl.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (camera.width <= 0 || camera.height <= 0) {
            this.stats.cpuMs = performance.now() - start;
            return;
        }

        // floor(camera) is an exact integer: subtracted from integer world
        // coordinates in the shader, it keeps float32 precision everywhere
        this.camX = Math.floor(camera.x);
        this.camY = Math.floor(camera.y);
        this.camFracX = camera.x - this.camX;
        this.camFracY = camera.y - this.camY;
        this.zoom = camera.zoom;
        this.cssWidth = camera.width;
        this.cssHeight = camera.height;
        this.dpr = this.deviceWidth > 0 ? this.deviceWidth / camera.width : 1;

        gl.activeTexture(gl.TEXTURE0 + PALETTE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, o.palette);

        const view = camera.visiblePixels();
        if (view.x1 > view.x0 && view.y1 > view.y0) {
            // 2. "Not loaded yet" pattern under everything
            gl.bindVertexArray(o.quadVao);
            this.useProgram(o.quad);
            gl.uniform1i(o.quad.u.u_white, 0);
            this.drawQuad(o.quad, view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);

            // 3. Chunks, each texture sized to its on-screen footprint
            const lod = selectLod(camera.zoom * this.dpr);
            const visible = chunks.prepareVisible(
                Math.floor(view.x0 / CHUNK_SIZE),
                Math.floor(view.y0 / CHUNK_SIZE),
                Math.floor((view.x1 - 1) / CHUNK_SIZE),
                Math.floor((view.y1 - 1) / CHUNK_SIZE),
                lod,
                camera.x,
                camera.y,
            );
            this.deferred = chunks.hasDeferredWork;
            this.drawChunks(o, visible);
        }

        // 4. Overlays
        this.drawOverlays(o, layers);
        gl.bindVertexArray(null);
        this.stats.cpuMs = performance.now() - start;
    }

    dispose(): void {
        const gl = this.gl;
        const o = this.objects;
        if (o && !gl.isContextLost()) {
            for (const p of [o.quad, o.ids, o.rgba, o.overlay]) gl.deleteProgram(p.program);
            gl.deleteBuffer(o.quadVbo);
            gl.deleteVertexArray(o.quadVao);
            gl.deleteVertexArray(o.overlayVao);
            gl.deleteTexture(o.palette);
            for (const layer of this.layerBuffers.values()) gl.deleteBuffer(layer.buffer);
        }
        this.objects = null;
        this.layerBuffers.clear();
        this.deferred = false;
    }

    // ---- Passes ----

    // Grouped by program: white quads, then palette ids, then downsampled colors
    private drawChunks(o: GLObjects, visible: readonly DrawableChunk[]) {
        const gl = this.gl;

        // The quad program is still bound from the background pass
        gl.uniform1i(o.quad.u.u_white, 1);
        for (const chunk of visible) if (!chunk.texture) this.drawChunk(o.quad, chunk);

        let bound = false;
        let loading: boolean | null = null;
        for (const chunk of visible) {
            if (!chunk.texture || chunk.textureLod !== 0) continue;
            if (!bound) {
                this.useProgram(o.ids);
                gl.activeTexture(gl.TEXTURE0 + IDS_UNIT);
                bound = true;
            }
            if (chunk.loading !== loading) {
                loading = chunk.loading;
                gl.uniform1i(o.ids.u.u_loading, loading ? 1 : 0);
            }
            gl.bindTexture(gl.TEXTURE_2D, chunk.texture);
            this.drawChunk(o.ids, chunk);
        }

        bound = false;
        let lodShift = -1;
        for (const chunk of visible) {
            // A loading chunk never holds a downsampled texture (ChunkStore), but stay safe
            if (!chunk.texture || chunk.textureLod === 0 || chunk.loading) continue;
            if (!bound) {
                this.useProgram(o.rgba);
                gl.activeTexture(gl.TEXTURE0 + COLORS_UNIT);
                bound = true;
            }
            if (chunk.textureLod !== lodShift) {
                lodShift = chunk.textureLod;
                gl.uniform1i(o.rgba.u.u_lodShift, lodShift);
            }
            gl.bindTexture(gl.TEXTURE_2D, chunk.texture);
            this.drawChunk(o.rgba, chunk);
        }
    }

    private drawOverlays(o: GLObjects, layers: readonly OverlayBuffer[]) {
        const gl = this.gl;
        let bound = false;
        for (const layer of layers) {
            const count = layer.count;
            if (count === 0) continue; // its version moves on: re-uploaded once it has content
            const buffer = this.syncLayer(layer);
            if (!bound) {
                this.useProgram(o.overlay);
                gl.uniform1f(o.overlay.u.u_ring, Math.max(1, Math.round(SELECTION_RING_CSS_PX * this.dpr)) / this.dpr);
                gl.bindVertexArray(o.overlayVao);
                gl.enable(gl.BLEND);
                bound = true;
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.vertexAttribPointer(A_INSTANCE, OVERLAY_STRIDE, gl.FLOAT, false, OVERLAY_STRIDE * 4, 0);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
            this.stats.drawCalls++;
        }
        if (bound) gl.disable(gl.BLEND);
    }

    // Uploads a layer's instances when its content changed since the last upload
    private syncLayer(layer: OverlayBuffer): WebGLBuffer {
        const gl = this.gl;
        let entry = this.layerBuffers.get(layer.id);
        if (!entry) {
            entry = { buffer: gl.createBuffer(), capacity: 0, source: null, version: -1 };
            this.layerBuffers.set(layer.id, entry);
        }
        // A new OverlayBuffer under the same id restarts its version count
        if (entry.source !== layer || entry.version !== layer.version) {
            const floats = layer.count * OVERLAY_STRIDE;
            gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
            if (floats * 4 > entry.capacity) {
                entry.capacity = Math.max(floats * 4, entry.capacity * 2, 4096);
                gl.bufferData(gl.ARRAY_BUFFER, entry.capacity, gl.DYNAMIC_DRAW);
            }
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, layer.data, 0, floats);
            entry.source = layer;
            entry.version = layer.version;
        }
        return entry.buffer;
    }

    // ---- Helpers ----

    private useProgram(p: ProgramInfo<ViewUniform>) {
        const gl = this.gl;
        gl.useProgram(p.program);
        gl.uniform2f(p.u.u_resolution, this.cssWidth, this.cssHeight);
        gl.uniform2i(p.u.u_camInt, this.camX, this.camY);
        gl.uniform2f(p.u.u_camFrac, this.camFracX, this.camFracY);
        gl.uniform1f(p.u.u_zoom, this.zoom);
        gl.uniform1f(p.u.u_dpr, this.dpr);
    }

    private drawChunk(p: ProgramInfo<ChunkUniform>, chunk: DrawableChunk) {
        this.drawQuad(p, chunk.cx * CHUNK_SIZE, chunk.cy * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
    }

    // Integer origin and size: neighbouring quads share bitwise-identical edges
    private drawQuad(p: ProgramInfo<ChunkUniform>, x: number, y: number, w: number, h: number) {
        const gl = this.gl;
        gl.uniform2i(p.u.u_origin, x, y);
        gl.uniform2i(p.u.u_size, w, h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.stats.drawCalls++;
    }

    private link<N extends string>(name: string, vsSource: string, fsSource: string, uniforms: readonly N[], created: WebGLProgram[]): ProgramInfo<N> {
        const gl = this.gl;
        const vs = this.compile(gl.VERTEX_SHADER, vsSource, `${name} vertex`);
        let fs: WebGLShader;
        try {
            fs = this.compile(gl.FRAGMENT_SHADER, fsSource, `${name} fragment`);
        } catch (e) {
            gl.deleteShader(vs);
            throw e;
        }
        const program = gl.createProgram();
        created.push(program);
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        // Flagged for deletion: freed together with the program
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
            throw new Error(`WebGL program "${name}" link failed: ${gl.getProgramInfoLog(program)}`);
        }
        const u = {} as Record<N, WebGLUniformLocation | null>;
        // null when the compiler optimized a uniform out: setting it is then a no-op
        for (const uniform of uniforms) u[uniform] = gl.getUniformLocation(program, uniform);
        return { program, u };
    }

    private compile(type: number, source: string, label: string): WebGLShader {
        const gl = this.gl;
        const shader = gl.createShader(type);
        if (!shader) throw new Error(`WebGL could not create the ${label} shader`);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`WebGL ${label} shader compile failed: ${log}`);
        }
        return shader;
    }
}
