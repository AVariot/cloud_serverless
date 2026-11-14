// Brush geometry: footprints, Bresenham lines and dense strokes on the grid.
import { GRID_SIZE } from '../config';
import type { BrushShape } from '../types';

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 16;

const clampSize = (size: number) =>
    Number.isFinite(size) ? Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, Math.round(size))) : MIN_BRUSH_SIZE;

const cacheIndex = (size: number, shape: BrushShape) => (shape === 'round' ? MAX_BRUSH_SIZE : 0) + size - 1;

const footprintCache: (Int16Array | undefined)[] = [];
/** Per footprint, 9 arrays indexed by step direction: see edgesOf() */
const edgeCache: (Int16Array[] | undefined)[] = [];

/**
 * Brush footprint as flat [dx0, dy0, dx1, dy1, ...] offsets from the cursor, row-major.
 * Square: offsets in [-floor((size-1)/2), ceil((size-1)/2)] on both axes, so even
 * sizes keep the cursor at the top-left of the central 2x2.
 * Round: cells of that square whose center lies within the circle of radius size/2
 * around the footprint's center. The squared radius is shrunk by 0.5 so small sizes
 * match the usual pixel-art brushes (3 = plus, 4 = square without corners, ...);
 * a plain r² keeps the corners of size 3 (distance sqrt(2) < 1.5).
 * The returned array is cached and shared: do not mutate it.
 */
export function brushOffsets(size: number, shape: BrushShape): Int16Array {
    const s = clampSize(size);
    const idx = cacheIndex(s, shape);
    const cached = footprintCache[idx];
    if (cached) return cached;

    const lo = -Math.floor((s - 1) / 2);
    const hi = Math.ceil((s - 1) / 2);
    const center = (lo + hi + 1) / 2;         // in cell-edge coordinates
    const limit = (s / 2) * (s / 2) - 0.5;
    const out: number[] = [];
    for (let dy = lo; dy <= hi; dy++) {
        for (let dx = lo; dx <= hi; dx++) {
            if (shape === 'round' && s > 2) {
                const ex = dx + 0.5 - center;
                const ey = dy + 0.5 - center;
                if (ex * ex + ey * ey > limit) continue;
            }
            out.push(dx, dy);
        }
    }
    const arr = Int16Array.from(out);
    footprintCache[idx] = arr;
    return arr;
}

const dirIndex = (sx: number, sy: number) => (sy + 1) * 3 + (sx + 1);

/**
 * For each unit step s (8 directions + none), the footprint cells that a stamp at
 * p + s adds to a stamp at p: { o in F : o + s not in F } (shifted by p + s).
 * Stamping only these along a line divides the work by ~size for big brushes.
 */
function edgesOf(size: number, shape: BrushShape): Int16Array[] {
    const s = clampSize(size);
    const idx = cacheIndex(s, shape);
    const cached = edgeCache[idx];
    if (cached) return cached;

    const offsets = brushOffsets(s, shape);
    const inFootprint = new Set<number>();
    const pack = (dx: number, dy: number) => (dy + 64) * 128 + (dx + 64);
    for (let i = 0; i < offsets.length; i += 2) inFootprint.add(pack(offsets[i], offsets[i + 1]));

    const edges: Int16Array[] = [];
    for (let sy = -1; sy <= 1; sy++) {
        for (let sx = -1; sx <= 1; sx++) {
            const out: number[] = [];
            for (let i = 0; i < offsets.length; i += 2) {
                const dx = offsets[i];
                const dy = offsets[i + 1];
                if (!inFootprint.has(pack(dx + sx, dy + sy))) out.push(dx, dy);
            }
            edges[dirIndex(sx, sy)] = Int16Array.from(out);
        }
    }
    edgeCache[idx] = edges;
    return edges;
}

/**
 * Bresenham line, both ends included, 8-connected (no gaps).
 * Expects integer pixel coordinates; fractional inputs are floored.
 */
export function forEachLinePixel(x0: number, y0: number, x1: number, y1: number, cb: (x: number, y: number) => void): void {
    let x = Math.floor(x0);
    let y = Math.floor(y0);
    const xe = Math.floor(x1);
    const ye = Math.floor(y1);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    for (;;) {
        cb(x, y);
        if (x === xe && y === ye) return;
        const e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y += sy;
        }
    }
}

function stamp(cx: number, cy: number, offsets: Int16Array, out: Set<number>): void {
    for (let i = 0; i < offsets.length; i += 2) {
        const x = cx + offsets[i];
        const y = cy + offsets[i + 1];
        if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE) out.add(y * GRID_SIZE + x);
    }
}

/**
 * Adds to `out` the keys (y * GRID_SIZE + x) covered by the brush dragged from
 * `from` to `to` (both stamped), or by a single stamp at `to` when `from` is null.
 * Dense whatever the distance between pointer events; cells outside the grid are clipped.
 */
export function strokePixels(
    from: { x: number; y: number } | null,
    to: { x: number; y: number },
    size: number,
    shape: BrushShape,
    out: Set<number>,
): void {
    const offsets = brushOffsets(size, shape);
    const tx = Math.floor(to.x);
    const ty = Math.floor(to.y);
    if (!from) {
        stamp(tx, ty, offsets, out);
        return;
    }
    const edges = edgesOf(size, shape);
    let px = 0;
    let py = 0;
    let first = true;
    forEachLinePixel(from.x, from.y, tx, ty, (x, y) => {
        // Full stamp at the start, then only the cells each unit step uncovers
        stamp(x, y, first ? offsets : edges[dirIndex(x - px, y - py)], out);
        first = false;
        px = x;
        py = y;
    });
}

export function keyToPixel(key: number): { x: number; y: number } {
    return { x: key % GRID_SIZE, y: Math.floor(key / GRID_SIZE) };
}
