import { getApp, getApps, initializeApp } from 'firebase/app';
import { initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import { ENV } from '../config';

let db: Firestore | null = null;

// Firestore is read-only from the browser (security rules: pixels readable, every
// write refused). No Firebase Auth: reads are anonymous, writes go through POST /draw.
export function getDb(): Firestore {
    if (db) return db;
    if (!ENV.firebaseProjectId) throw new Error('VITE_FIREBASE_PROJECT_ID is not defined');
    const app = getApps().length
        ? getApp()
        : initializeApp({ projectId: ENV.firebaseProjectId, ...(ENV.firebaseApiKey ? { apiKey: ENV.firebaseApiKey } : {}) });
    db = initializeFirestore(app, {
        // Memory cache with eager garbage collection: documents read by the paginated
        // chunk loads are released right away (the engine keeps its own compact copy,
        // 1 byte per pixel), only the small live-delta result sets stay in the SDK.
        localCache: memoryLocalCache(),
        ignoreUndefinedProperties: true,
    });
    return db;
}
