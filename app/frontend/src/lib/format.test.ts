import { describe, expect, it } from 'vitest';
import {
    buildPixelLink,
    countLabel,
    formatCoords,
    formatCount,
    formatRelativeTime,
    formatZoom,
    isLightRgb,
    MAX_COORD,
    parseCoordinate,
    plural,
    splitCoordinatePair,
} from './format';

/** Intl uses (narrow) no-break spaces: normalize them for readable assertions */
const spaces = (s: string) => s.replace(/[\u00A0\u202F]/g, ' ');

describe('numbers', () => {
    it('groups thousands the French way', () => {
        expect(spaces(formatCount(1234567))).toBe('1 234 567');
        expect(formatCount(42)).toBe('42');
    });

    it('uses the singular for 0 and 1', () => {
        expect(plural(0, 'pixel')).toBe('pixel');
        expect(plural(1, 'pixel')).toBe('pixel');
        expect(plural(2, 'pixel')).toBe('pixels');
        expect(plural(3, 'travail', 'travaux')).toBe('travaux');
        expect(spaces(countLabel(1500, 'zone'))).toBe('1 500 zones');
    });

    it('formats the zoom as a percentage', () => {
        expect(spaces(formatZoom(1))).toBe('100 %');
        expect(spaces(formatZoom(12.345))).toBe('1235 %');
        expect(spaces(formatZoom(0.005))).toBe('0.50 %');
    });
});

describe('coordinates', () => {
    it('formats a pair', () => {
        expect(formatCoords(12, 9999)).toBe('x 12 · y 9999');
    });

    it('parses valid coordinates', () => {
        expect(parseCoordinate('0')).toEqual({ ok: true, value: 0 });
        expect(parseCoordinate(' 9999 ')).toEqual({ ok: true, value: MAX_COORD });
    });

    it('rejects empty, non-integer and out-of-range values', () => {
        expect(parseCoordinate('  ')).toEqual({ ok: false, error: 'empty' });
        expect(parseCoordinate('12.5')).toEqual({ ok: false, error: 'format' });
        expect(parseCoordinate('-1')).toEqual({ ok: false, error: 'format' });
        expect(parseCoordinate('abc')).toEqual({ ok: false, error: 'format' });
        expect(parseCoordinate('10000')).toEqual({ ok: false, error: 'range' });
    });

    it('splits pasted pairs', () => {
        expect(splitCoordinatePair('1234, 5678')).toEqual(['1234', '5678']);
        expect(splitCoordinatePair('1234 5678')).toEqual(['1234', '5678']);
        expect(splitCoordinatePair('1234;5678')).toEqual(['1234', '5678']);
        expect(splitCoordinatePair('(12,34)')).toEqual(['12', '34']);
        expect(splitCoordinatePair('x 1234 · y 5678')).toEqual(['1234', '5678']);
        expect(splitCoordinatePair('X=1 y=2')).toEqual(['1', '2']);
    });

    it('does not split single values or garbage', () => {
        expect(splitCoordinatePair('1234')).toBeNull();
        expect(splitCoordinatePair('12, 34, 56')).toBeNull();
        expect(splitCoordinatePair('a, b')).toBeNull();
        expect(splitCoordinatePair('')).toBeNull();
    });

    it('builds a share link with a rounded zoom', () => {
        expect(buildPixelLink('https://place.test', '/', 12, 34, 8.4567)).toBe('https://place.test/?x=12&y=34&z=8.46');
        expect(buildPixelLink('http://localhost:3000', '/app', 0, 0, 20)).toBe('http://localhost:3000/app?x=0&y=0&z=20');
        expect(buildPixelLink('http://localhost:3000', '/', 1, 2, Number.NaN)).toBe('http://localhost:3000/?x=1&y=2');
    });
});

describe('formatRelativeTime', () => {
    const at = (year: number, month: number, day: number, hour = 0, minute = 0) =>
        new Date(year, month, day, hour, minute).getTime();
    const now = at(2026, 10, 12, 14, 30); // 12 Nov 2026, 14:30 local time

    it('says "à l’instant" for the last minute and future timestamps', () => {
        expect(formatRelativeTime(now, now)).toBe('à l’instant');
        expect(formatRelativeTime(now - 59_000, now)).toBe('à l’instant');
        expect(formatRelativeTime(now + 5_000, now)).toBe('à l’instant');
    });

    it('counts minutes then hours', () => {
        expect(formatRelativeTime(now - 3 * 60_000, now)).toBe('il y a 3 min');
        expect(formatRelativeTime(now - 59 * 60_000, now)).toBe('il y a 59 min');
        expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('il y a 2 h');
        expect(formatRelativeTime(at(2026, 10, 12, 0, 5), now)).toBe('il y a 14 h');
    });

    it('keeps hours across midnight when recent', () => {
        expect(formatRelativeTime(at(2026, 10, 11, 23, 0), at(2026, 10, 12, 1, 0))).toBe('il y a 2 h');
    });

    it('says "hier" for the previous calendar day', () => {
        expect(formatRelativeTime(at(2026, 10, 11, 8, 5), now)).toMatch(/^hier à 08:05$/);
    });

    it('shows a date for older timestamps, with the year when it differs', () => {
        expect(spaces(formatRelativeTime(at(2026, 10, 3, 9, 0), now))).toBe('3 nov.');
        expect(spaces(formatRelativeTime(at(2025, 0, 15, 9, 0), now))).toBe('15 janv. 2025');
    });
});

describe('isLightRgb', () => {
    it('separates light and dark swatches', () => {
        expect(isLightRgb([255, 255, 255])).toBe(true);
        expect(isLightRgb([229, 217, 0])).toBe(true); // yellow
        expect(isLightRgb([34, 34, 34])).toBe(false);
        expect(isLightRgb([0, 0, 234])).toBe(false); // dark blue
    });
});
