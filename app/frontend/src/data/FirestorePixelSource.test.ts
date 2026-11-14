import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { chunkKey } from '../config';
import { paletteColor, parseChunkIds, timestampToMillis, toPixelDoc } from './FirestorePixelSource';

describe('parseChunkIds', () => {
    it('parses backend chunk ids into chunk keys', () => {
        expect([...parseChunkIds(['0_0', '19_19', '4_3'])]).toEqual([chunkKey(0, 0), chunkKey(19, 19), chunkKey(4, 3)]);
    });

    it('refuses lists that cannot be one `in` filter', () => {
        expect(() => parseChunkIds([])).toThrow(RangeError);
        expect(() => parseChunkIds(Array.from({ length: 31 }, (_, i) => `${i % 20}_${Math.floor(i / 20)}`))).toThrow(RangeError);
        expect(() => parseChunkIds(Array.from({ length: 30 }, (_, i) => `${i % 20}_${Math.floor(i / 20)}`))).not.toThrow();
    });

    it('refuses ids the backend never writes', () => {
        for (const id of ['a_b', '05_3', '20_0', '0_20', '-1_0', '1_2_3', '']) {
            expect(() => parseChunkIds([id]), id).toThrow(RangeError);
        }
    });
});

describe('doc conversion', () => {
    const allowed = new Set([chunkKey(0, 0), chunkKey(1, 0)]);
    const ts = Timestamp.fromMillis(1_700_000_000_123);

    it('keeps valid docs of the requested chunks', () => {
        expect(toPixelDoc({ x: 600, y: 2, color: 7, updated_at: ts, user_id: 'u', chunk: '1_0' }, allowed))
            .toEqual({ x: 600, y: 2, color: 7, updatedAtMs: 1_700_000_000_123 });
    });

    it('skips docs that cannot be placed', () => {
        expect(toPixelDoc({ x: 1.5, y: 2, color: 1 }, allowed)).toBeNull();
        expect(toPixelDoc({ x: '1', y: 2, color: 1 }, allowed)).toBeNull();
        expect(toPixelDoc({ y: 2, color: 1 }, allowed)).toBeNull();
        expect(toPixelDoc({ x: -1, y: 2, color: 1 }, allowed)).toBeNull();
        expect(toPixelDoc({ x: 10_000, y: 2, color: 1 }, null)).toBeNull();
        // chunk field says 0_0 but x/y belong to 2_0: not a chunk we asked for
        expect(toPixelDoc({ x: 1200, y: 2, color: 1, chunk: '0_0' }, allowed)).toBeNull();
        expect(toPixelDoc({ x: 1200, y: 2, color: 1 }, null)).not.toBeNull();
    });

    it('renders invalid colors as empty and missing timestamps as 0', () => {
        expect(toPixelDoc({ x: 1, y: 1, color: 300 }, allowed)).toEqual({ x: 1, y: 1, color: 0, updatedAtMs: 0 });
        expect(paletteColor(2.5)).toBe(0);
        expect(paletteColor(-1)).toBe(0);
        expect(paletteColor('3')).toBe(0);
        expect(paletteColor(undefined)).toBe(0);
        expect(paletteColor(255)).toBe(255);
        expect(timestampToMillis(ts)).toBe(1_700_000_000_123);
        expect(timestampToMillis({ toMillis: () => 42 })).toBe(42);
        expect(timestampToMillis('2024-01-01')).toBe(0);
        expect(timestampToMillis(null)).toBe(0);
    });
});
