const API_URL = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const CDN_URL = 'https://cdn.discordapp.com';
const SCOPES = ['identify'];
const STATE_KEY = 'discord_oauth_state';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;
const REDIRECT_URI = import.meta.env.VITE_DISCORD_REDIRECT_URI ?? window.location.origin;

export interface DiscordUser {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
    locale?: string;
}

export interface DiscordToken {
    accessToken: string;
    expiresIn: number;
}

export class UnauthorizedError extends Error {}

/** OAuth redirect outcome: a token, a user-facing error, or nothing (no callback in the URL) */
export type CallbackResult = { token: DiscordToken } | { error: string } | null;

function randomState(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // randomUUID needs a secure context (missing on plain-http LAN testing)
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function redirectToDiscord() {
    if (!CLIENT_ID) throw new Error('VITE_DISCORD_CLIENT_ID is not defined');
    const state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'token',
        scope: SCOPES.join(' '),
        state,
        prompt: 'none',
    });
    window.location.assign(`${AUTHORIZE_URL}?${params}`);
}

export function consumeCallback(): CallbackResult {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (!hash.has('access_token') && !hash.has('error')) return null;

    const expectedState = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    // The token must not stay in the address bar (history, screenshots, shared links)
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    const error = hash.get('error');
    if (error) {
        return { error: error === 'access_denied' ? 'Connexion annulée sur Discord.' : `Discord a refusé la connexion (${error}).` };
    }
    const accessToken = hash.get('access_token');
    if (!accessToken || !expectedState || hash.get('state') !== expectedState) {
        return { error: 'Réponse de Discord invalide, veuillez réessayer.' };
    }
    return { token: { accessToken, expiresIn: Number(hash.get('expires_in')) || 604800 } };
}

export async function fetchCurrentUser(accessToken: string): Promise<DiscordUser> {
    const response = await fetch(`${API_URL}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) throw new Error(`Discord API error: ${response.status}`);
    return response.json();
}

export function getAvatarUrl(user: DiscordUser, size = 128): string {
    if (user.avatar) {
        const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
        return `${CDN_URL}/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
    }
    const index = Number((BigInt(user.id) >> BigInt(22)) % BigInt(6));
    return `${CDN_URL}/embed/avatars/${index}.png`;
}
