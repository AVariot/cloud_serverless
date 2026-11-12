// The palette is shared with the backend: config/palette.json at the repository
// root is the single source of truth (Terraform passes it to the functions).
// Firestore stores palette ids (1..255); 0 means "empty pixel" and is never drawable.
import paletteJson from '../../../config/palette.json';

export interface PaletteColor {
    id: number;
    name: string;
    hex: string;                        // "#RRGGBB", upper case
    rgb: readonly [number, number, number];
}

export const EMPTY_COLOR_ID = 0;
/** Color shown for empty (never painted) pixels: the white canvas, as on r/place */
export const EMPTY_RGB: readonly [number, number, number] = [255, 255, 255];
/** Color shown for an id missing from the palette (palette updated server side) */
export const UNKNOWN_RGB: readonly [number, number, number] = [255, 0, 255];

function parseHex(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error(`Invalid palette color "${hex}"`);
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function load(): PaletteColor[] {
    const seen = new Set<number>();
    const colors = paletteJson.colors.map((c) => {
        if (!Number.isInteger(c.id) || c.id < 1 || c.id > 255) throw new Error(`Palette id ${c.id} out of 1..255`);
        if (seen.has(c.id)) throw new Error(`Duplicate palette id ${c.id}`);
        seen.add(c.id);
        const rgb = parseHex(c.hex);
        return { id: c.id, name: c.name, hex: `#${c.hex.replace('#', '').toUpperCase()}`, rgb } as PaletteColor;
    });
    if (colors.length === 0) throw new Error('Empty palette');
    return colors.sort((a, b) => a.id - b.id);
}

/** Drawable colors, sorted by id */
export const PALETTE: readonly PaletteColor[] = load();

const byId = new Map(PALETTE.map((c) => [c.id, c]));

export const colorById = (id: number): PaletteColor | undefined => byId.get(id);
export const isDrawableColor = (id: number) => byId.has(id);

/** Default brush/placement color: black if present, else the first one */
export const DEFAULT_COLOR_ID = PALETTE.find((c) => c.name.toLowerCase() === 'noir')?.id ?? PALETTE[0].id;

/**
 * RGBA lookup table, 256 entries x 4 bytes: index = palette id.
 * 0 -> EMPTY_RGB, unknown ids -> UNKNOWN_RGB. Alpha is always 255.
 * Uploaded as the 256x1 palette texture and used for CPU downsampling.
 */
export const PALETTE_LUT: Uint8Array = (() => {
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        const rgb = i === EMPTY_COLOR_ID ? EMPTY_RGB : (byId.get(i)?.rgb ?? UNKNOWN_RGB);
        lut[i * 4] = rgb[0];
        lut[i * 4 + 1] = rgb[1];
        lut[i * 4 + 2] = rgb[2];
        lut[i * 4 + 3] = 255;
    }
    return lut;
})();

export function colorLabel(id: number): string {
    if (id === EMPTY_COLOR_ID) return 'Vide';
    return byId.get(id)?.name ?? `Couleur ${id}`;
}

export function colorHex(id: number): string {
    const o = id * 4;
    const n = (PALETTE_LUT[o] << 16) | (PALETTE_LUT[o + 1] << 8) | PALETTE_LUT[o + 2];
    return `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
}
