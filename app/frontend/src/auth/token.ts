import { getCookie, removeCookie } from './cookies';

// The Discord access token lives in localStorage, not in a cookie: a cookie would be
// sent along with every request to the static host, and the token must only ever
// travel to Discord and, as a Bearer header, to the gateway. It is never stored server side.
const KEY = 'discord_token';
const LEGACY_COOKIE = 'discord_token';

interface Stored {
    token: string;
    expiresAt: number; // ms since epoch
}

function read(): Stored | null {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as Partial<Stored>;
        if (typeof v.token !== 'string' || !v.token || typeof v.expiresAt !== 'number') return null;
        return { token: v.token, expiresAt: v.expiresAt };
    } catch {
        return null; // storage blocked or corrupted: logged out
    }
}

export function getToken(): string | null {
    const v = read();
    if (v && v.expiresAt > Date.now()) return v.token;
    if (v) clearToken();
    // One-time migration from the former cookie storage
    const legacy = getCookie(LEGACY_COOKIE);
    if (legacy) {
        removeCookie(LEGACY_COOKIE);
        setToken(legacy, 24 * 3600); // remaining lifetime unknown: Discord rejects it if expired
        return legacy;
    }
    return null;
}

export function setToken(token: string, expiresInSeconds: number) {
    try {
        localStorage.setItem(KEY, JSON.stringify({ token, expiresAt: Date.now() + expiresInSeconds * 1000 }));
    } catch {
        // Storage blocked (private mode policies): the session lasts until reload
        memoryFallback = token;
    }
}

export function clearToken() {
    memoryFallback = null;
    try {
        localStorage.removeItem(KEY);
    } catch {
        // nothing stored
    }
    removeCookie(LEGACY_COOKIE);
}

let memoryFallback: string | null = null;

/** Token for API calls, including the in-memory fallback when storage is blocked */
export function currentToken(): string | null {
    return getToken() ?? memoryFallback;
}

/** Expiry of the stored session (ms since epoch), null when unknown or kept in memory only */
export function tokenExpiresAt(): number | null {
    return read()?.expiresAt ?? null;
}
