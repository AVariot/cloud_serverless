// Grid geometry. CHUNK_SIZE is a contract with the backend (draw-pixel writes
// chunk = "cx_cy" with cx = floor(x / 500)): never change one side alone.
export const GRID_SIZE = 10_000;
export const CHUNK_SIZE = 500;
export const CHUNKS_PER_SIDE = GRID_SIZE / CHUNK_SIZE; // 20
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;     // 250 000 pixels
export const TOTAL_CHUNKS = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;

/** Numeric chunk key, used for every Map/Set in the frontend */
export const chunkKey = (cx: number, cy: number) => cy * CHUNKS_PER_SIDE + cx;
export const chunkOfKey = (key: number) => ({ cx: key % CHUNKS_PER_SIDE, cy: Math.floor(key / CHUNKS_PER_SIDE) });
export const chunkKeyOfPixel = (x: number, y: number) => chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));

/** Firestore `chunk` field value, same format as the backend's chunkID(): "cx_cy" */
export const chunkId = (cx: number, cy: number) => `${cx}_${cy}`;

/** Firestore document id of a pixel: pixels/{x}_{y} */
export const pixelDocId = (x: number, y: number) => `${x}_${y}`;

export const isInGrid = (x: number, y: number) =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE;

/**
 * Minimum zoom (CSS px per pixel) to paint with the brush. Zoomed further out a
 * drag would cover thousands of pixels the user cannot even see: it pans instead.
 */
export const MIN_PAINT_ZOOM = 2;

/** Pixel index inside its chunk (row-major) */
export const localIndex = (x: number, y: number) => (y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE);

const env = import.meta.env;

export const ENV = {
    gatewayUrl: (env.VITE_GATEWAY_URL ?? '').trim().replace(/\/+$/, ''),
    pixelApiKey: (env.VITE_PIXEL_API_KEY ?? '').trim(),
    firebaseProjectId: (env.VITE_FIREBASE_PROJECT_ID ?? '').trim(),
    firebaseApiKey: (env.VITE_FIREBASE_API_KEY ?? '').trim() || undefined,
} as const;

/** Human readable list of missing settings (empty when the app is fully configured) */
export function missingEnv(): string[] {
    const missing: string[] = [];
    if (!ENV.gatewayUrl) missing.push('VITE_GATEWAY_URL');
    if (!ENV.pixelApiKey) missing.push('VITE_PIXEL_API_KEY');
    if (!ENV.firebaseProjectId) missing.push('VITE_FIREBASE_PROJECT_ID');
    return missing;
}
