/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_DISCORD_CLIENT_ID?: string;
    readonly VITE_DISCORD_REDIRECT_URI?: string;
    /** API Gateway base URL, e.g. https://pixel-gw-xxxx.ew.gateway.dev */
    readonly VITE_GATEWAY_URL?: string;
    /** Gateway API key (x-api-key). Browser-visible by design, restricted to the gateway service. */
    readonly VITE_PIXEL_API_KEY?: string;
    /** GCP project hosting Firestore (read-only from the browser) */
    readonly VITE_FIREBASE_PROJECT_ID?: string;
    /** Optional: only needed if the project enforces API keys on Firestore */
    readonly VITE_FIREBASE_API_KEY?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
