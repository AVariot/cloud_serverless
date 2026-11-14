import { describe, expect, it } from 'vitest';
import { GRID_SIZE } from '../config';
import type { BrushShape } from '../types';
import { brushOffsets, forEachLinePixel, keyToPixel, strokePixels } from './brush';

/** ASCII art of a footprint: '#' covered, '.' not, '@'/'o' = cursor covered/not */
function ascii(size: number, shape: BrushShape): string {
    const o = brushOffsets(size, shape);
    let lo = 0;
    let hi = 0;
    for (const v of o) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
    }
    const set = new Set<string>();
    for (let i = 0; i < o.length; i += 2) set.add(`${o[i]},${o[i + 1]}`);
    const rows: string[] = [];
    for (let y = lo; y <= hi; y++) {
        let r = '';
        for (let x = lo; x <= hi; x++) {
            const on = set.has(`${x},${y}`);
            r += x === 0 && y === 0 ? (on ? '@' : 'o') : on ? '#' : '.';
        }
        rows.push(r);
    }
    return rows.join('\n');
}

const key = (x: number, y: number) => y * GRID_SIZE + x;

/** Reference implementation: full stamp at every line pixel, no edge optimization */
function bruteStroke(x0: number, y0: number, x1: number, y1: number, size: number, shape: BrushShape): Set<number> {
    const out = new Set<number>();
    const o = brushOffsets(size, shape);
    forEachLinePixel(x0, y0, x1, y1, (cx, cy) => {
        for (let i = 0; i < o.length; i += 2) {
            const x = cx + o[i];
            const y = cy + o[i + 1];
            if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE) out.add(key(x, y));
        }
    });
    return out;
}

describe('brushOffsets', () => {
    it('square footprints are size x size, cursor at the top-left of the center for even sizes', () => {
        for (let s = 1; s <= 16; s++) expect(brushOffsets(s, 'square').length / 2).toBe(s * s);
        expect(Array.from(brushOffsets(1, 'square'))).toEqual([0, 0]);
        expect(Array.from(brushOffsets(2, 'square'))).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
        expect(ascii(3, 'square')).toBe('###\n#@#\n###');
        expect(ascii(4, 'square')).toBe('####\n#@##\n####\n####');
    });

    it('round footprints look like the usual pixel-art brushes (sizes 1..8)', () => {
        const expected: Record<number, string> = {
            1: '@',
            2: '@#\n##',
            3: '.#.\n#@#\n.#.',
            4: '.##.\n#@##\n####\n.##.',
            5: '.###.\n#####\n##@##\n#####\n.###.',
            6: '.####.\n######\n##@###\n######\n######\n.####.',
            7: '..###..\n.#####.\n#######\n###@###\n#######\n.#####.\n..###..',
            8: '..####..\n.######.\n########\n###@####\n########\n########\n.######.\n..####..',
        };
        for (let s = 1; s <= 8; s++) expect(ascii(s, 'round'), `round ${s}`).toBe(expected[s]);
    });

    it('round footprints are symmetric and always cover the cursor', () => {
        for (let s = 1; s <= 16; s++) {
            const o = brushOffsets(s, 'round');
            const set = new Set<string>();
            for (let i = 0; i < o.length; i += 2) set.add(`${o[i]},${o[i + 1]}`);
            expect(set.has('0,0')).toBe(true);
            const lo = -Math.floor((s - 1) / 2);
            const hi = Math.ceil((s - 1) / 2);
            // Mirror around the footprint center: d -> lo + hi - d
            for (let i = 0; i < o.length; i += 2) {
                expect(set.has(`${lo + hi - o[i]},${o[i + 1]}`)).toBe(true);
                expect(set.has(`${o[i + 1]},${o[i]}`)).toBe(true);
            }
            expect(o.length / 2).toBeLessThanOrEqual(s * s);
        }
    });

    it('clamps the size to 1..16 and caches the arrays', () => {
        expect(brushOffsets(0, 'square')).toBe(brushOffsets(1, 'square'));
        expect(brushOffsets(-5, 'round')).toBe(brushOffsets(1, 'round'));
        expect(brushOffsets(100, 'square')).toBe(brushOffsets(16, 'square'));
        expect(brushOffsets(Number.NaN, 'square')).toBe(brushOffsets(1, 'square'));
        expect(brushOffsets(16, 'square').length / 2).toBe(256);
        expect(brushOffsets(5, 'round')).not.toBe(brushOffsets(5, 'square'));
    });
});

describe('forEachLinePixel', () => {
    it('includes both ends and is 8-connected without duplicates', () => {
        const segments = [
            [0, 0, 0, 0], [0, 0, 10, 0], [10, 0, 0, 0], [0, 0, 0, -7], [3, 4, 50, 17],
            [50, 17, 3, 4], [0, 0, 13, 13], [5, 5, -20, 9], [100, 100, 101, 250],
        ];
        for (const [x0, y0, x1, y1] of segments) {
            const pts: [number, number][] = [];
            forEachLinePixel(x0, y0, x1, y1, (x, y) => pts.push([x, y]));
            expect(pts[0]).toEqual([x0, y0]);
            expect(pts[pts.length - 1]).toEqual([x1, y1]);
            expect(pts.length).toBe(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1);
            for (let i = 1; i < pts.length; i++) {
                expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThanOrEqual(1);
                expect(Math.abs(pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(1);
            }
            expect(new Set(pts.map((p) => p.join(','))).size).toBe(pts.length);
        }
    });
});

describe('strokePixels', () => {
    it('stamps only at `to` when from is null', () => {
        const out = new Set<number>();
        strokePixels(null, { x: 500, y: 600 }, 3, 'round', out);
        expect([...out].sort((a, b) => a - b)).toEqual(
            [key(500, 599), key(499, 600), key(500, 600), key(501, 600), key(500, 601)].sort((a, b) => a - b),
        );
    });

    it('is dense for long jumps and matches a full stamp at every line pixel', () => {
        const cases: [number, number, number, number][] = [
            [100, 100, 900, 130], [900, 130, 100, 100], [200, 200, 200, 1200], [50, 50, 400, 400],
            [400, 50, 50, 400], [300, 300, 301, 300], [300, 300, 300, 300], [1000, 1000, 1003, 2000],
        ];
        for (const shape of ['square', 'round'] as const) {
            for (const size of [1, 2, 3, 4, 7, 16]) {
                for (const [x0, y0, x1, y1] of cases) {
                    const out = new Set<number>();
                    strokePixels({ x: x0, y: y0 }, { x: x1, y: y1 }, size, shape, out);
                    expect(out, `${shape} ${size} (${x0},${y0})->(${x1},${y1})`).toEqual(bruteStroke(x0, y0, x1, y1, size, shape));
                }
            }
        }
    });

    it('a 1px stroke has no gaps between far apart pointer events', () => {
        const out = new Set<number>();
        strokePixels({ x: 0, y: 0 }, { x: 2000, y: 700 }, 1, 'square', out);
        expect(out.size).toBe(2001);
        for (let x = 0; x <= 2000; x++) {
            let found = 0;
            for (let y = 0; y <= 700; y++) if (out.has(key(x, y))) found++;
            expect(found).toBe(1); // exactly one pixel per column for an x-major line
        }
    });

    it('clips to the grid at every border', () => {
        const corners: [number, number][] = [[0, 0], [GRID_SIZE - 1, 0], [0, GRID_SIZE - 1], [GRID_SIZE - 1, GRID_SIZE - 1]];
        for (const [x, y] of corners) {
            const out = new Set<number>();
            strokePixels(null, { x, y }, 5, 'square', out);
            expect(out.size).toBe(9); // 3x3 quarter of the 5x5 square
            for (const k of out) {
                expect(k).toBeGreaterThanOrEqual(0);
                expect(k).toBeLessThan(GRID_SIZE * GRID_SIZE);
            }
        }
        // A segment running outside the grid only keeps in-grid cells (no wrap-around to other rows)
        const out = new Set<number>();
        strokePixels({ x: -50, y: 10 }, { x: 20, y: 10 }, 3, 'square', out);
        expect(out).toEqual(bruteStroke(-50, 10, 20, 10, 3, 'square'));
        for (const k of out) {
            const p = keyToPixel(k);
            expect(p.x).toBeLessThanOrEqual(21);
            expect(p.y).toBeGreaterThanOrEqual(9);
            expect(p.y).toBeLessThanOrEqual(11);
        }
        expect(out.size).toBe(22 * 3);
        const right = new Set<number>();
        strokePixels({ x: GRID_SIZE - 3, y: 5 }, { x: GRID_SIZE + 40, y: 5 }, 1, 'square', right);
        expect([...right].map(keyToPixel)).toEqual([
            { x: GRID_SIZE - 3, y: 5 }, { x: GRID_SIZE - 2, y: 5 }, { x: GRID_SIZE - 1, y: 5 },
        ]);
    });
});

describe('keyToPixel', () => {
    it('inverts y * GRID_SIZE + x', () => {
        for (const [x, y] of [[0, 0], [9999, 0], [0, 9999], [9999, 9999], [1234, 5678]]) {
            expect(keyToPixel(key(x, y))).toEqual({ x, y });
        }
    });
});
