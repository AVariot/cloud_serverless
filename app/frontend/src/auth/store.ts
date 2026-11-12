import { create } from 'zustand';
import { consumeCallback, fetchCurrentUser, redirectToDiscord, UnauthorizedError, type DiscordUser } from './discord';
import { clearToken, currentToken, setToken } from './token';

// Transient failures of Discord's /users/@me (rate limit, 5xx, network) are retried:
// a valid session must not be thrown back to the login screen by a blip
const RETRY_DELAYS_MS = [1000, 3000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let initializing: Promise<void> | null = null;

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
    status: AuthStatus;
    user: DiscordUser | null;
    error: string | null;

    initialize: () => Promise<void>;
    login: () => void;
    /** message: shown on the login screen (e.g. session expired) */
    logout: (message?: string) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
    status: 'loading',
    user: null,
    error: null,

    // Idempotent: StrictMode runs the AuthGate effect twice
    initialize: () => {
        initializing ??= (async () => {
            const callback = consumeCallback();
            if (callback && 'token' in callback) setToken(callback.token.accessToken, callback.token.expiresIn);
            const callbackError = callback && 'error' in callback ? callback.error : null;

            const token = currentToken();
            if (!token) {
                set({ status: 'unauthenticated', user: null, error: callbackError });
                return;
            }

            for (let attempt = 0; ; attempt++) {
                try {
                    const user = await fetchCurrentUser(token);
                    set({ status: 'authenticated', user, error: null });
                    return;
                } catch (e) {
                    if (e instanceof UnauthorizedError) {
                        clearToken();
                        set({ status: 'unauthenticated', user: null, error: 'Votre session Discord a expiré. Reconnectez-vous.' });
                        return;
                    }
                    if (attempt >= RETRY_DELAYS_MS.length) {
                        // Token kept: the next reload retries without a new Discord login
                        set({ status: 'unauthenticated', user: null, error: 'Discord est injoignable pour le moment. Réessayez dans un instant.' });
                        return;
                    }
                    await sleep(RETRY_DELAYS_MS[attempt]);
                }
            }
        })().finally(() => {
            initializing = null;
        });
        return initializing;
    },

    login: () => {
        try {
            redirectToDiscord();
        } catch (e) {
            set({ error: e instanceof Error ? e.message : String(e) });
        }
    },

    logout: (message) => {
        clearToken();
        set({ status: 'unauthenticated', user: null, error: message ?? null });
    },
}));
