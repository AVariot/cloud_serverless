import { CHUNK_SIZE, GRID_SIZE, MIN_PAINT_ZOOM } from '../config';
import { brushOffsets, strokePixels } from '../draw/brush';
import type { BrushShape, ChunkRect, ChunkState, PendingPixel, PixelUpdate, Tool } from '../types';
import { Camera } from './Camera';
import { ChunkStore } from './ChunkStore';
import { InputController } from './InputController';
import { OverlayBuffer, OverlayStyle } from './overlay';
import { Renderer } from './Renderer';

const FOCUS_ZOOM = 20;          // zoom used when flying to a pixel
const TAP_FOCUS_BELOW = 6;      // tapping while zoomed out under this flies to the pixel
const HOVER_OUTLINE_ZOOM = 4;   // hover outline only once pixels are big enough to aim at
const MAX_FRAME_DT = 0.1;
const VIEW_THROTTLE_MS = 100;

export interface EngineCallbacks {
    /** Visible chunk rectangle (null when nothing is visible) and the view center in pixels. Throttled. */
    onViewChange(rect: ChunkRect | null, center: { x: number; y: number }): void;
    /** Camera settled after a move (deep-link update) */
    onViewIdle(center: { x: number; y: number }, zoom: number): void;
    onHover(pixel: { x: number; y: number } | null): void;
    onZoom(zoom: number): void;
    /** Select tool: a pixel was clicked/tapped */
    onTapPixel(x: number, y: number): void;
    /** Brush tool: pixel keys (y * GRID_SIZE + x) covered by the latest stroke segment */
    onPaint(keys: Set<number>): void;
}

export interface PendingSource {
    readonly version: number;
    forEachPending(cb: (p: PendingPixel) => void): void;
}

// Wires camera, pixel storage, renderer and input. Knows nothing about Firestore
// or HTTP: the runtime feeds it pixels and receives taps/strokes. Frames are
// rendered on demand only.
export class WebGLEngine {
    private canvas: HTMLCanvasElement;
    private gl: WebGL2RenderingContext;
    private camera = new Camera();
    private chunks: ChunkStore;
    private renderer: Renderer;
    private input: InputController;
    private resizeObserver: ResizeObserver;
    private callbacks: EngineCallbacks;

    // Overlays: pending draws, and the cursor layer (brush footprint, hover, selection)
    private pendingLayer = new OverlayBuffer('pending');
    private cursorLayer = new OverlayBuffer('cursor');
    private layers = [this.pendingLayer, this.cursorLayer];
    private pendingSource: PendingSource | null = null;
    private pendingVersion = -1;
    private cursorDirty = true;

    // Tool state (mirrors the UI store)
    private tool: Tool = 'select';
    private colorId = 1;
    private brushSize = 1;
    private brushShape: BrushShape = 'square';
    private selection: { x: number; y: number } | null = null;
    private placing = false;

    private insets = { top: 0, bottom: 0 };
    private prevInsets = { top: 0, bottom: 0 };
    private hoverPixel: { x: number; y: number } | null = null;
    private strokeLast: { x: number; y: number } | null = null;
    private strokeKeys: Set<number> | null = null;
    private strokeFlushScheduled = false;
    private panning = false;

    private frameId = 0;
    private lastFrameTime = 0;
    private viewTimer = 0;
    private lastViewEmit = 0;
    private lastViewKey = '';
    private lastViewCenter = { x: -1e9, y: -1e9 };
    private idleTimer = 0;
    private destroyed = false;

    constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks) {
        this.canvas = canvas;
        this.callbacks = callbacks;
        const gl = canvas.getContext('webgl2', {
            antialias: false,
            alpha: false,
            depth: false,
            stencil: false,
            powerPreference: 'high-performance',
        });
        if (!gl) throw new Error('WebGL2 not supported');
        this.gl = gl;

        // Shader compilation is the only step that can throw: it runs before any
        // listener or observer is attached, so a failure leaks nothing.
        this.renderer = new Renderer(gl);
        this.renderer.init();
        this.chunks = new ChunkStore(gl);

        this.input = new InputController(canvas, {
            onInteractionStart: () => this.camera.stop(),
            onPan: (dx, dy) => {
                this.camera.pan(dx, dy);
                this.cameraMoved();
            },
            onZoom: (factor, x, y) => {
                this.camera.zoomAt(this.camera.zoom * factor, x, y);
                this.hover(x, y); // the pixel under the pointer changed
                this.cameraMoved();
            },
            onTap: (x, y) => this.tapAt(x, y),
            onHover: (x, y) => this.hover(x, y),
            onLeave: () => this.setHoverPixel(null),
            canStroke: () => this.camera.zoom >= MIN_PAINT_ZOOM,
            onStrokeStart: (x, y) => this.stroke(x, y, true),
            onStrokeMove: (x, y) => this.stroke(x, y, false),
            onStrokeEnd: () => {
                this.strokeLast = null;
            },
            onPanningChange: (panning) => {
                this.panning = panning;
                this.updateCursor();
                this.invalidateCursorLayer(); // the brush preview is hidden while panning
            },
        });

        canvas.addEventListener('webglcontextlost', this.onContextLost);
        canvas.addEventListener('webglcontextrestored', this.onContextRestored);

        // Observing the canvas itself: changing canvas.width/height never changes its
        // CSS size, so there is no feedback loop. Rendering synchronously avoids the
        // blank frame caused by resizing the drawing buffer.
        this.resizeObserver = new ResizeObserver((entries) => this.resize(entries[0]));
        try {
            this.resizeObserver.observe(canvas, { box: 'device-pixel-content-box' });
        } catch {
            // Content-box observers miss devicePixelRatio changes (moving to another screen)
            this.resizeObserver.observe(canvas);
            window.addEventListener('resize', this.onWindowResize);
        }

        this.updateCursor();
        this.resize();
    }

    public destroy() {
        this.destroyed = true;
        cancelAnimationFrame(this.frameId);
        this.frameId = 0;
        clearTimeout(this.viewTimer);
        clearTimeout(this.idleTimer);
        this.resizeObserver.disconnect();
        window.removeEventListener('resize', this.onWindowResize);
        this.input.dispose();
        this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
        this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
        // Release GPU memory (StrictMode mounts the engine twice on the same context)
        this.chunks.dispose();
        this.renderer.dispose();
    }

    // --- Pixel data (fed by the sync layer through the runtime) ---

    public chunkState(cx: number, cy: number): ChunkState {
        return this.chunks.state(cx, cy);
    }

    public beginLoad(cx: number, cy: number) {
        this.chunks.beginLoad(cx, cy);
        this.requestRender();
    }

    public finishLoad(cx: number, cy: number) {
        this.chunks.finishLoad(cx, cy);
        this.requestRender();
    }

    public evict(cx: number, cy: number) {
        this.chunks.evict(cx, cy);
        this.requestRender();
    }

    public applyPixels(updates: readonly PixelUpdate[]) {
        if (this.chunks.applyPixels(updates)) this.requestRender();
    }

    /** Known color of a pixel, null when its chunk is not fully loaded */
    public getPixel(x: number, y: number): number | null {
        return this.chunks.getPixel(x, y);
    }

    public getStats() {
        return { ...this.chunks.stats(), ...this.renderer.stats };
    }

    // --- Tool state ---

    public setTool(tool: Tool) {
        if (tool === this.tool) return;
        this.tool = tool;
        this.strokeLast = null;
        this.input.setMode(tool === 'brush' ? 'brush' : 'select');
        this.updateCursor();
        this.invalidateCursorLayer();
    }

    public setColor(colorId: number) {
        if (colorId === this.colorId) return;
        this.colorId = colorId;
        this.invalidateCursorLayer();
    }

    public setBrush(size: number, shape: BrushShape) {
        if (size === this.brushSize && shape === this.brushShape) return;
        this.brushSize = size;
        this.brushShape = shape;
        this.invalidateCursorLayer();
    }

    public setSelection(selection: { x: number; y: number } | null, placing: boolean) {
        const same = selection === this.selection ||
            (selection && this.selection && selection.x === this.selection.x && selection.y === this.selection.y);
        if (same && placing === this.placing) return;
        this.selection = selection ? { ...selection } : null;
        this.placing = placing;
        this.invalidateCursorLayer();
    }

    /** The pending-draw overlay is rebuilt lazily (once per frame) when the source's version changes */
    public setPendingSource(source: PendingSource | null) {
        this.pendingSource = source;
        this.pendingVersion = -1;
        this.requestRender();
    }

    public pendingChanged() {
        this.requestRender();
    }

    // --- Camera commands ---

    /** Screen space covered by UI panels (CSS px), so fly-to targets land in the visible area */
    public setViewInsets(top: number, bottom: number) {
        // An inset taller than the screen would push targets off-screen: keep the center usable
        const max = this.camera.height * 0.45;
        this.prevInsets = this.insets;
        this.insets = { top: Math.min(top, max), bottom: Math.min(bottom, max) };
    }

    public flyTo(x: number, y: number, zoom?: number) {
        const z = zoom ?? Math.max(this.camera.targetZoom, FOCUS_ZOOM);
        // Shift the camera so the pixel sits halfway between the top and bottom panels
        const dy = (this.insets.bottom - this.insets.top) / 2 / z;
        this.camera.flyTo(x + 0.5, y + 0.5 + dy, z);
        this.cameraMoved();
    }

    /**
     * Brings a pixel back into the area not covered by panels, without changing the
     * zoom; does nothing when it is already visible. During a fly-to, re-targets it
     * with the current insets (the inspector may have appeared since it started).
     */
    public ensureVisible(x: number, y: number, reason: 'selection' | 'insets') {
        const c = this.camera;
        if (c.width === 0 || c.height === 0 || this.input.isPanning) return;
        if (c.isAnimating) {
            const t = c.targetCenter;
            // Only re-target a fly-to that is heading to this pixel
            if (Math.abs(t.x - (x + 0.5)) < 1 && Math.abs(t.y - (y + 0.5)) < c.height / c.targetZoom) this.flyTo(x, y, c.targetZoom);
            return;
        }
        // A panel that grew only pulls the camera back if it covered a pixel the user
        // was looking at: a pixel they panned away from on purpose stays where it is
        if (reason === 'insets' && !this.isOnScreen(x, y, this.prevInsets)) return;
        if (!this.isOnScreen(x, y, this.insets)) this.flyTo(x, y, c.targetZoom);
    }

    private isOnScreen(x: number, y: number, insets: { top: number; bottom: number }) {
        const c = this.camera, margin = 24;
        const sx = (x + 0.5 - c.x) * c.zoom + c.width / 2;
        const sy = (y + 0.5 - c.y) * c.zoom + c.height / 2;
        return sx >= margin && sx <= c.width - margin && sy >= insets.top + margin && sy <= c.height - insets.bottom - margin;
    }

    public fitToMap() {
        this.camera.fitToGrid();
        this.cameraMoved();
    }

    public zoomBy(factor: number) {
        const c = this.camera.targetCenter;
        this.camera.flyTo(c.x, c.y, this.camera.targetZoom * factor);
        this.cameraMoved();
    }

    /** Moves the camera instantly (deep links, initial view). x, y are pixel-center coordinates. */
    public jumpTo(x: number, y: number, zoom: number) {
        this.camera.flyTo(x, y, zoom);
        this.camera.finish();
        this.cameraMoved();
    }

    public get view() {
        return { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom };
    }

    // --- Rendering ---

    public requestRender() {
        if (this.frameId || this.destroyed || this.gl.isContextLost()) return;
        this.frameId = requestAnimationFrame(this.frame);
    }

    private frame = (time: number) => {
        this.frameId = 0;

        if (this.camera.isAnimating) {
            const dt = this.lastFrameTime ? Math.min((time - this.lastFrameTime) / 1000, MAX_FRAME_DT) : 1 / 60;
            const animating = this.camera.update(dt);
            this.lastFrameTime = animating ? time : 0;
            this.callbacks.onZoom(this.camera.zoom);
            this.scheduleViewChange();
            this.rehover(); // the pixel under a still mouse moved
            if (animating) this.requestRender();
        } else {
            this.lastFrameTime = 0;
        }

        this.renderNow();
        if (this.renderer.hasDeferredWork) this.requestRender();
    };

    private renderNow() {
        this.rebuildPendingLayer();
        if (this.cursorDirty) this.rebuildCursorLayer();
        this.renderer.render(this.camera, this.chunks, this.layers);
    }

    private rebuildPendingLayer() {
        const src = this.pendingSource;
        if (!src) {
            if (this.pendingLayer.count) this.pendingLayer.clear();
            return;
        }
        if (src.version === this.pendingVersion) return;
        this.pendingVersion = src.version;
        const layer = this.pendingLayer;
        layer.clear();
        src.forEachPending((p) => layer.push(p.x, p.y, p.color, OverlayStyle.PENDING));
    }

    private rebuildCursorLayer() {
        this.cursorDirty = false;
        const layer = this.cursorLayer;
        layer.clear();
        const hover = this.hoverPixel;

        if (this.tool === 'brush') {
            // Footprint preview under the pointer (hidden while panning or too far out to paint)
            if (hover && !this.panning && this.camera.zoom >= MIN_PAINT_ZOOM) {
                const offsets = brushOffsets(this.brushSize, this.brushShape);
                for (let i = 0; i < offsets.length; i += 2) {
                    const x = hover.x + offsets[i], y = hover.y + offsets[i + 1];
                    if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE) layer.push(x, y, this.colorId, OverlayStyle.BRUSH);
                }
            }
            return;
        }

        const sel = this.selection;
        if (hover && this.camera.zoom >= HOVER_OUTLINE_ZOOM && !(sel && sel.x === hover.x && sel.y === hover.y)) {
            layer.push(hover.x, hover.y, 0, OverlayStyle.HOVER);
        }
        if (sel) {
            if (this.placing) layer.push(sel.x, sel.y, this.colorId, OverlayStyle.PREVIEW);
            layer.push(sel.x, sel.y, 0, OverlayStyle.SELECTION);
        }
    }

    private invalidateCursorLayer() {
        this.cursorDirty = true;
        this.requestRender();
    }

    private onWindowResize = () => this.resize();

    private resize(entry?: ResizeObserverEntry) {
        if (this.destroyed) return;
        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        const device = entry?.devicePixelContentBoxSize?.[0];
        const deviceWidth = device ? device.inlineSize : Math.round(width * dpr);
        const deviceHeight = device ? device.blockSize : Math.round(height * dpr);

        if (this.canvas.width !== deviceWidth || this.canvas.height !== deviceHeight) {
            this.canvas.width = deviceWidth;
            this.canvas.height = deviceHeight;
        }
        // The browser may allocate a smaller drawing buffer than requested (size or memory
        // limits): the viewport must cover what actually exists
        this.renderer.setViewport(this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
        this.camera.setViewport(width, height);
        this.rehover();
        this.callbacks.onZoom(this.camera.zoom);
        this.scheduleViewChange();
        this.renderNow();
        if (this.camera.isAnimating || this.renderer.hasDeferredWork) this.requestRender();
    }

    // Every camera change: re-render, report zoom, throttle the visible-area report
    private cameraMoved() {
        this.callbacks.onZoom(this.camera.zoom);
        this.cursorDirty = true;
        this.updateCursor();
        this.rehover();
        this.scheduleViewChange();
        this.requestRender();
    }

    private toChunkRect(v: { x0: number; y0: number; x1: number; y1: number }): ChunkRect | null {
        if (this.camera.width === 0 || this.camera.height === 0) return null;
        if (v.x1 <= v.x0 || v.y1 <= v.y0) return null;
        return {
            cx0: Math.floor(v.x0 / CHUNK_SIZE),
            cy0: Math.floor(v.y0 / CHUNK_SIZE),
            cx1: Math.floor((v.x1 - 1) / CHUNK_SIZE),
            cy1: Math.floor((v.y1 - 1) / CHUNK_SIZE),
        };
    }

    // Leading + trailing throttle: loads start immediately when a pan begins and
    // the final position is always reported
    private scheduleViewChange() {
        clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => {
            if (!this.camera.isAnimating) this.callbacks.onViewIdle({ x: this.camera.x, y: this.camera.y }, this.camera.zoom);
        }, 400);

        if (this.viewTimer) return;
        const wait = Math.max(0, VIEW_THROTTLE_MS - (performance.now() - this.lastViewEmit));
        this.viewTimer = window.setTimeout(() => {
            this.viewTimer = 0;
            this.lastViewEmit = performance.now();
            this.emitView();
        }, wait);
    }

    private emitView() {
        if (this.destroyed) return;
        // During a fly-to, ask for the destination right away: loading the areas the
        // camera only passes over would waste reads and delay the chunks that matter
        const target = this.camera.targetView();
        const rect = this.toChunkRect(target.bounds);
        const center = { x: target.x, y: target.y };
        const key = rect ? `${rect.cx0},${rect.cy0},${rect.cx1},${rect.cy1}` : 'none';
        // The center only matters for load priority: with an unchanged chunk set,
        // report again only once it moved by half a chunk
        const moved = Math.hypot(center.x - this.lastViewCenter.x, center.y - this.lastViewCenter.y);
        if (key === this.lastViewKey && moved < CHUNK_SIZE / 2) return;
        this.lastViewKey = key;
        this.lastViewCenter = center;
        this.callbacks.onViewChange(rect, center);
    }

    // --- Interaction ---

    private toPixel(sx: number, sy: number) {
        const world = this.camera.screenToWorld(sx, sy);
        const px = Math.floor(world.x), py = Math.floor(world.y);
        const inGrid = px >= 0 && px < GRID_SIZE && py >= 0 && py < GRID_SIZE;
        return { px, py, inGrid };
    }

    /** Recomputes the hovered pixel from the last mouse position (camera moved under it) */
    private rehover() {
        const m = this.input?.mousePosition;
        if (m) this.hover(m.x, m.y);
    }

    private hover(sx: number, sy: number) {
        const { px, py, inGrid } = this.toPixel(sx, sy);
        this.setHoverPixel(inGrid ? { x: px, y: py } : null);
    }

    private setHoverPixel(p: { x: number; y: number } | null) {
        const cur = this.hoverPixel;
        if (cur === p || (cur && p && cur.x === p.x && cur.y === p.y)) return;
        this.hoverPixel = p;
        this.callbacks.onHover(p);
        this.invalidateCursorLayer();
    }

    private tapAt(sx: number, sy: number) {
        const { px, py, inGrid } = this.toPixel(sx, sy);
        if (!inGrid) return;
        this.setHoverPixel({ x: px, y: py }); // touch has no hover: report the tapped pixel
        this.callbacks.onTapPixel(px, py);
        // Zoomed out, a pixel is too small to work with: bring it closer (r/place behavior)
        if (this.camera.targetZoom < TAP_FOCUS_BELOW) this.flyTo(px, py, FOCUS_ZOOM);
    }

    private stroke(sx: number, sy: number, start: boolean) {
        if (this.tool !== 'brush') return;
        const world = this.camera.screenToWorld(sx, sy);
        const p = { x: Math.floor(world.x), y: Math.floor(world.y) };
        const from = start ? null : this.strokeLast;
        if (!start && from && from.x === p.x && from.y === p.y) return;
        this.strokeLast = p;
        // Coalesced pointer samples (high-rate mice and pens) all land in one set,
        // flushed once: one enqueue and one hover update per event, not per sample.
        // Clipping to the grid happens in strokePixels.
        this.strokeKeys ??= new Set<number>();
        strokePixels(from, p, this.brushSize, this.brushShape, this.strokeKeys);
        if (!this.strokeFlushScheduled) {
            this.strokeFlushScheduled = true;
            queueMicrotask(this.flushStroke);
        }
    }

    private flushStroke = () => {
        this.strokeFlushScheduled = false;
        const keys = this.strokeKeys;
        this.strokeKeys = null;
        if (this.destroyed) return;
        const p = this.strokeLast;
        if (p) this.setHoverPixel(p.x >= 0 && p.y >= 0 && p.x < GRID_SIZE && p.y < GRID_SIZE ? p : null);
        if (keys && keys.size) this.callbacks.onPaint(keys);
    };

    private updateCursor() {
        const cursor = this.panning ? 'grabbing'
            : this.tool !== 'brush' ? 'default'
            : this.camera.zoom >= MIN_PAINT_ZOOM ? 'crosshair' : 'grab';
        if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
    }

    // --- Context loss ---

    private onContextLost = (e: Event) => {
        e.preventDefault(); // allows the browser to restore the context
        cancelAnimationFrame(this.frameId);
        this.frameId = 0;
    };

    private onContextRestored = () => {
        this.renderer.init();
        this.renderer.setViewport(this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
        this.chunks.restore();
        this.pendingVersion = -1;
        this.cursorDirty = true;
        this.requestRender();
    };
}
