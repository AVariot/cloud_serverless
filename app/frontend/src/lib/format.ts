// Pure formatting / parsing helpers for the UI (French locale). No React, no DOM.
import { GRID_SIZE } from '../config';

const LOCALE = 'fr-FR';
/** Narrow no-break space: French separator before % and inside numbers */
const NNBSP = '\u202F';

export const MAX_COORD = GRID_SIZE - 1;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const countFormat = new Intl.NumberFormat(LOCALE);

/** 12345 -> "12 345" (French grouping) */
export const formatCount = (n: number) => countFormat.format(n);

/** French plural: 0 and 1 take the singular */
export const plural = (n: number, singular: string, pluralForm = `${singular}s`) =>
    Math.abs(n) < 2 ? singular : pluralForm;

/** 3 -> "3 pixels", 1 -> "1 pixel" */
export const countLabel = (n: number, singular: string, pluralForm?: string) =>
    `${formatCount(n)} ${plural(n, singular, pluralForm)}`;

/** Camera zoom (1 = 100 %) as a percentage */
export function formatZoom(zoom: number): string {
    const percent = zoom * 100;
    return `${percent >= 1 ? percent.toFixed(0) : percent.toPrecision(2)}${NNBSP}%`;
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export const formatCoords = (x: number, y: number) => `x ${x} · y ${y}`;

export type CoordinateError = 'empty' | 'format' | 'range';
export type CoordinateParse = { ok: true; value: number } | { ok: false; error: CoordinateError };

/** Parses one grid coordinate typed by the user: integer in 0..max */
export function parseCoordinate(raw: string, max = MAX_COORD): CoordinateParse {
    const s = raw.trim();
    if (!s) return { ok: false, error: 'empty' };
    if (!/^\d+$/.test(s)) return { ok: false, error: 'format' };
    const value = Number(s);
    if (value > max) return { ok: false, error: 'range' };
    return { ok: true, value };
}

// "1234, 5678", "1234 5678", "1234;5678", "(1234, 5678)", "x 1234 · y 5678", "x=1 y=2"
const PAIR_RE = /^\s*\(?\s*(?:x\s*[:=]?\s*)?(\d+)\s*(?:[,;·]\s*|\s+)(?:y\s*[:=]?\s*)?(\d+)\s*\)?\s*$/i;

/** Splits a pasted "x, y" pair into its two raw parts, or null if it is not a pair */
export function splitCoordinatePair(raw: string): [string, string] | null {
    const m = PAIR_RE.exec(raw);
    return m ? [m[1], m[2]] : null;
}

/** Shareable link to a pixel: origin + path + ?x=&y=&z= (zoom rounded to 2 decimals) */
export function buildPixelLink(origin: string, pathname: string, x: number, y: number, zoom: number): string {
    const params = new URLSearchParams({ x: String(x), y: String(y) });
    if (Number.isFinite(zoom) && zoom > 0) params.set('z', String(Math.round(zoom * 100) / 100));
    return `${origin}${pathname}?${params}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formatTime = (d: Date) => d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });

/**
 * "à l'instant", "il y a 3 min", "il y a 2 h", "hier à 14:05", "3 nov.", "3 nov. 2025".
 * Timestamps in the future (clock skew) count as "à l'instant".
 */
export function formatRelativeTime(ms: number, now: number): string {
    const diff = now - ms;
    if (diff < MINUTE) return 'à l’instant';
    if (diff < HOUR) return `il y a ${Math.floor(diff / MINUTE)} min`;

    const date = new Date(ms);
    const today = new Date(now);
    const hours = Math.floor(diff / HOUR);
    if (isSameDay(date, today) || hours < 6) return `il y a ${hours} h`;

    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (isSameDay(date, yesterday)) return `hier à ${formatTime(date)}`;

    return date.toLocaleDateString(LOCALE, {
        day: 'numeric',
        month: 'short',
        ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
    });
}

/** Absolute date and time, for tooltips */
export const formatDateTime = (ms: number) => new Date(ms).toLocaleString(LOCALE);

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** True when dark content (text, check mark) reads better than white on this color */
export function isLightRgb(rgb: readonly [number, number, number]): boolean {
    const [r, g, b] = rgb;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}
