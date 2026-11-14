import { GRID_SIZE } from '../config';

const MAX_ZOOM = 50;
const SMOOTHING = 10; // per second, frame-rate independent
const EPSILON = 0.001;

export interface PixelBounds {
    x0: number;
    y0: number;
    x1: number; // exclusive
    y1: number; // exclusive
}

// Camera in world pixels. `zoom` is CSS pixels per world pixel.
// The camera is always clamped so the view never leaves the grid; when the
// whole grid fits on an axis, it is centered on that axis instead.
export class Camera {
    public x = GRID_SIZE / 2;
    public y = GRID_SIZE / 2;
    public zoom = 1;

    public width = 0;  // viewport, CSS pixels
    public height = 0;

    private target: { x: number; y: number; zoom: number } | null = null;

    // Lowest zoom shows the entire grid
    public get minZoom() {
        if (this.width === 0 || this.height === 0) return MAX_ZOOM;
        return Math.min(Math.min(this.width, this.height) / GRID_SIZE, MAX_ZOOM);
    }

    public get isAnimating() {
        return this.target !== null;
    }

    public get maxZoom() {
        return MAX_ZOOM;
    }

    // Zoom the camera is heading to (current zoom when not animating), so repeated
    // zoom commands compound instead of restarting from an intermediate value
    public get targetZoom() {
        if (!this.target) return this.zoom;
        return this.clampZoom(this.target.zoom <= 0 ? this.minZoom : this.target.zoom);
    }

    public get targetCenter() {
        return this.target ? { x: this.target.x, y: this.target.y } : { x: this.x, y: this.y };
    }

    public setViewport(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.clamp();
    }

    public screenToWorld(sx: number, sy: number) {
        return {
            x: (sx - this.width / 2) / this.zoom + this.x,
            y: (sy - this.height / 2) / this.zoom + this.y,
        };
    }

    public pan(dx: number, dy: number) {
        this.target = null;
        this.x -= dx / this.zoom;
        this.y -= dy / this.zoom;
        this.clamp();
    }

    // Zooms keeping the world point under (sx, sy) fixed on screen
    public zoomAt(zoom: number, sx: number, sy: number) {
        this.target = null;
        const anchor = this.screenToWorld(sx, sy);
        this.zoom = this.clampZoom(zoom);
        this.x = anchor.x - (sx - this.width / 2) / this.zoom;
        this.y = anchor.y - (sy - this.height / 2) / this.zoom;
        this.clamp();
    }

    // The target is stored unclamped and re-clamped every frame, so a resize
    // mid-flight can never leave the animation chasing an unreachable point.
    // zoom <= 0 means "fit the whole map" (resolved against the live viewport).
    public flyTo(x: number, y: number, zoom: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return;
        this.target = { x, y, zoom };
    }

    public fitToGrid() {
        this.flyTo(GRID_SIZE / 2, GRID_SIZE / 2, 0);
    }

    // Jumps straight to the current fly-to target
    public finish() {
        if (!this.target || this.width === 0 || this.height === 0) return;
        this.update(1e3);
        this.target = null;
    }

    public stop() {
        this.target = null;
    }

    // Advances the fly-to animation; returns true while still animating.
    // Paused (target kept) while the viewport has no size.
    public update(dt: number): boolean {
        if (!this.target || this.width === 0 || this.height === 0) return false;

        const zoom = this.clampZoom(this.target.zoom);
        const x = this.clampAxis(this.target.x, this.width, zoom);
        const y = this.clampAxis(this.target.y, this.height, zoom);

        const k = 1 - Math.exp(-SMOOTHING * dt);
        this.x += (x - this.x) * k;
        this.y += (y - this.y) * k;
        // Interpolate zoom in log space so zooming feels uniform across scales
        this.zoom = Math.exp(Math.log(this.zoom) + (Math.log(zoom) - Math.log(this.zoom)) * k);

        if (Math.abs(x - this.x) < EPSILON && Math.abs(y - this.y) < EPSILON && Math.abs(zoom - this.zoom) < EPSILON * zoom) {
            this.x = x;
            this.y = y;
            this.zoom = zoom;
            this.target = null;
        }
        this.clamp();
        return this.target !== null;
    }

    // Visible grid area, clipped to the grid and snapped to whole pixels
    public visiblePixels(): PixelBounds {
        return this.boundsAt(this.x, this.y, this.zoom);
    }

    /** Where the view will be once the current fly-to ends (the current view when idle) */
    public targetView(): { bounds: PixelBounds; x: number; y: number } {
        if (!this.target || this.width === 0 || this.height === 0) {
            return { bounds: this.visiblePixels(), x: this.x, y: this.y };
        }
        const zoom = this.clampZoom(this.target.zoom <= 0 ? this.minZoom : this.target.zoom);
        const x = this.clampAxis(this.target.x, this.width, zoom);
        const y = this.clampAxis(this.target.y, this.height, zoom);
        return { bounds: this.boundsAt(x, y, zoom), x, y };
    }

    private boundsAt(x: number, y: number, zoom: number): PixelBounds {
        const halfW = this.width / zoom / 2;
        const halfH = this.height / zoom / 2;
        return {
            x0: Math.max(0, Math.floor(x - halfW)),
            y0: Math.max(0, Math.floor(y - halfH)),
            x1: Math.min(GRID_SIZE, Math.ceil(x + halfW)),
            y1: Math.min(GRID_SIZE, Math.ceil(y + halfH)),
        };
    }

    private clampZoom(zoom: number) {
        if (Number.isNaN(zoom)) return this.zoom;
        return Math.max(this.minZoom, Math.min(zoom, MAX_ZOOM));
    }

    private clampAxis(pos: number, viewport: number, zoom: number) {
        const half = viewport / zoom / 2;
        if (half * 2 >= GRID_SIZE) return GRID_SIZE / 2;
        return Math.max(half, Math.min(pos, GRID_SIZE - half));
    }

    private clamp() {
        if (this.width === 0 || this.height === 0) return;
        this.zoom = this.clampZoom(this.zoom);
        this.x = this.clampAxis(this.x, this.width, this.zoom);
        this.y = this.clampAxis(this.y, this.height, this.zoom);
    }
}
