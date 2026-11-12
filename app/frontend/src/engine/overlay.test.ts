import { describe, expect, it } from 'vitest';
import { OVERLAY_STRIDE, OverlayBuffer, OverlayStyle } from './overlay';

describe('OverlayBuffer', () => {
    it('stores 4 floats per instance and bumps the version on every mutation', () => {
        const layer = new OverlayBuffer('cursor');
        expect(layer.id).toBe('cursor');
        expect(layer.count).toBe(0);
        const v0 = layer.version;
        layer.push(12, 34, 5, OverlayStyle.PREVIEW);
        layer.push(13, 34, 0, OverlayStyle.SELECTION);
        expect(layer.count).toBe(2);
        expect(layer.version).toBe(v0 + 2);
        expect(Array.from(layer.data.subarray(0, 2 * OVERLAY_STRIDE))).toEqual([12, 34, 5, 0, 13, 34, 0, 2]);
        layer.clear();
        expect(layer.count).toBe(0);
        expect(layer.version).toBe(v0 + 3);
    });

    it('grows without losing instances', () => {
        const layer = new OverlayBuffer('pending');
        for (let i = 0; i < 1000; i++) layer.push(i, 2 * i, i % 16, OverlayStyle.PENDING);
        expect(layer.count).toBe(1000);
        expect(layer.data.length).toBeGreaterThanOrEqual(1000 * OVERLAY_STRIDE);
        for (const i of [0, 63, 64, 999]) {
            expect(Array.from(layer.data.subarray(i * 4, i * 4 + 4))).toEqual([i, 2 * i, i % 16, OverlayStyle.PENDING]);
        }
    });

    it('keeps coordinates whole and ids in palette range for the shader', () => {
        const layer = new OverlayBuffer('x');
        layer.push(10.7, -0.5, 256 + 3, OverlayStyle.BRUSH);
        expect(Array.from(layer.data.subarray(0, 4))).toEqual([10, -1, 3, OverlayStyle.BRUSH]);
    });
});
