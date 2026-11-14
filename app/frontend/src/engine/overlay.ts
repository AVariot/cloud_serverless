// Overlay layers drawn on top of the chunks (instanced quads, one draw call per layer).

/** Keep in sync with the STYLE_* constants of the overlay shaders */
export const OverlayStyle = { PREVIEW: 0, PENDING: 1, SELECTION: 2, BRUSH: 3, HOVER: 4 } as const;
export type OverlayStyleId = (typeof OverlayStyle)[keyof typeof OverlayStyle];

/** Floats per instance: x, y (world pixel), colorId (palette id), style */
export const OVERLAY_STRIDE = 4;

const INITIAL_CAPACITY = 64; // instances

// Growable instance list. The Renderer keeps one GL buffer per `id` and
// re-uploads it only when `version` changed: callers should skip clear/push
// when the layer content did not change.
export class OverlayBuffer {
    readonly id: string;
    private buf = new Float32Array(INITIAL_CAPACITY * OVERLAY_STRIDE);
    private n = 0;
    private ver = 0;

    constructor(id: string) {
        this.id = id;
    }

    get count(): number {
        return this.n;
    }

    /** Backing array: only the first count * 4 floats are valid */
    get data(): Float32Array {
        return this.buf;
    }

    get version(): number {
        return this.ver;
    }

    clear(): void {
        this.n = 0;
        this.ver++;
    }

    push(x: number, y: number, colorId: number, style: OverlayStyleId): void {
        let o = this.n * OVERLAY_STRIDE;
        if (o + OVERLAY_STRIDE > this.buf.length) {
            const grown = new Float32Array(this.buf.length * 2);
            grown.set(this.buf);
            this.buf = grown;
        }
        // The shader converts these to ints: keep them whole and in palette range
        this.buf[o++] = Math.floor(x);
        this.buf[o++] = Math.floor(y);
        this.buf[o++] = colorId & 255;
        this.buf[o] = style;
        this.n++;
        this.ver++;
    }
}
