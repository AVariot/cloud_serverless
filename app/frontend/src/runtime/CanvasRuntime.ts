import { useAuthStore } from '../auth/store';
import { currentToken } from '../auth/token';
import { CHUNK_SIZE, ENV, GRID_SIZE, isInGrid } from '../config';
import { ChunkSync } from '../data/ChunkSync';
import { FirestorePixelSource } from '../data/FirestorePixelSource';
import { getDb } from '../data/firebase';
import { DrawClient } from '../draw/drawClient';
import { DrawQueue } from '../draw/DrawQueue';
import { WebGLEngine } from '../engine';
import { useUIStore } from '../store';
import type { ChunkSink, DrawErrorKind, DrawRequest, PixelUpdate } from '../types';
import { registerCanvasCommands } from './bridge';

const DEFAULT_ZOOM = 2;
const LINK_ZOOM = 20;

// Composition root of the canvas: the WebGL engine (rendering + input), the
// Firestore sync (chunk loading + live deltas), the draw queue (POST /draw) and
// the UI store. Each part only knows its own job; this class wires them.
export class CanvasRuntime {
    private engine: WebGLEngine;
    private sync: ChunkSync | null = null;
    private queue: DrawQueue;
    private unsubStore: () => void;
    private urlTimer = 0;
    private destroyed = false;

    constructor(canvas: HTMLCanvasElement) {
        const store = useUIStore.getState;

        this.engine = new WebGLEngine(canvas, {
            onViewChange: (rect, center) => this.sync?.setView(rect, center),
            onViewIdle: (center, zoom) => this.writeUrl(center, zoom),
            onHover: (p) => store().setHover(p),
            onZoom: (zoom) => store().setZoom(zoom),
            onTapPixel: (x, y) => store().select(x, y),
            onPaint: (keys) => this.paint(keys),
        });

        // --- Draw pipeline ---
        const client = new DrawClient({
            gatewayUrl: ENV.gatewayUrl,
            apiKey: ENV.pixelApiKey,
            getToken: currentToken,
        });
        this.queue = new DrawQueue(client, {
            currentColor: (x, y) => this.knownColor(x, y),
            onChange: () => {
                if (this.destroyed) return;
                this.engine.pendingChanged();
                store().setDraw(this.queue.stats());
            },
            onError: (kind, message, detail) => this.onDrawError(kind, message, detail),
        }, {
            // Every request makes the proxy call Discord: a bounded backlog keeps a huge
            // brush session from turning into minutes of 503s
            maxQueue: 5_000,
        });
        this.engine.setPendingSource(this.queue);

        // --- Firestore sync ---
        const sink: ChunkSink = {
            beginLoad: (cx, cy) => this.engine.beginLoad(cx, cy),
            finishLoad: (cx, cy) => this.engine.finishLoad(cx, cy),
            evict: (cx, cy) => this.engine.evict(cx, cy),
            applyPixels: (updates: readonly PixelUpdate[]) => {
                // Engine first: the queue's no-op checks then see the new colors
                this.engine.applyPixels(updates);
                this.queue.confirm(updates);
            },
        };
        try {
            this.sync = new ChunkSync(new FirestorePixelSource(getDb()), sink, (stats) => {
                if (this.destroyed) return;
                store().setSync(stats);
                // No confirmation can arrive while the listeners are down: stop the clocks
                this.queue.setConfirmationsPaused(stats.status === 'offline' || stats.status === 'error');
            }, {
                // Longer than the draw queue's 20 s confirmation timeout: a pixel drawn
                // just before panning away is still confirmed by its chunk's listener
                lingerMs: 30_000,
                // Worst Pub/Sub delivery delay before the dead-letter topic: 5 attempts with
                // 10 s -> 300 s backoff (10 + 20 + 40 + 80 s) plus up to 60 s ack deadline each,
                // about 450 s. A write that late still falls inside the re-read window.
                safetyMs: 8 * 60_000,
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            store().setSync({ ...store().sync, status: 'error', error: message });
            store().pushToast('error', 'Lecture de la toile impossible', { detail: message, key: 'sync-init' });
        }

        // --- UI store -> engine ---
        const applyState = () => {
            const s = store();
            this.engine.setTool(s.tool);
            this.engine.setColor(s.colorId);
            this.engine.setBrush(s.brushSize, s.brushShape);
            this.engine.setSelection(s.tool === 'select' ? s.selected : null, s.placing);
            this.engine.setViewInsets(s.viewInsets.top, s.viewInsets.bottom);
        };
        applyState();
        this.unsubStore = useUIStore.subscribe((s, prev) => {
            if (s.tool !== prev.tool || s.colorId !== prev.colorId || s.brushSize !== prev.brushSize ||
                s.brushShape !== prev.brushShape || s.selected !== prev.selected || s.placing !== prev.placing ||
                s.viewInsets !== prev.viewInsets) {
                applyState();
            }
            // Keep the selected pixel out from under the panels (the inspector appears
            // after the selection, and the toolbar grows in placing mode)
            if (s.tool === 'select' && s.selected) {
                if (s.selected !== prev.selected) this.engine.ensureVisible(s.selected.x, s.selected.y, 'selection');
                else if (s.viewInsets !== prev.viewInsets) this.engine.ensureVisible(s.selected.x, s.selected.y, 'insets');
            }
        });

        registerCanvasCommands({
            flyTo: (x, y, zoom) => this.engine.flyTo(x, y, zoom),
            fitToMap: () => this.engine.fitToMap(),
            zoomBy: (factor) => this.engine.zoomBy(factor),
            placeSelected: () => this.placeSelected(),
            cancelQueuedDraws: () => {
                const n = this.queue.cancelQueued();
                if (n > 0) store().pushToast('info', `${n.toLocaleString('fr-FR')} pixel(s) retiré(s) de la file`, { key: 'queue-cancel' });
            },
        });

        this.initialView();

        // Dev-only handle for debugging from the console: __canvas.stats()
        if (import.meta.env.DEV) {
            (window as unknown as { __canvas?: unknown }).__canvas = {
                stats: () => ({ engine: this.engine.getStats(), draw: this.queue.stats(), sync: store().sync, view: this.engine.view }),
                engine: this.engine,
            };
        }
    }

    public destroy() {
        this.destroyed = true;
        if (import.meta.env.DEV) delete (window as unknown as { __canvas?: unknown }).__canvas;
        registerCanvasCommands(null);
        clearTimeout(this.urlTimer);
        this.unsubStore();
        this.sync?.dispose();
        this.queue.dispose();
        this.engine.destroy();
    }

    // --- Drawing ---

    private paint(keys: Set<number>) {
        const s = useUIStore.getState();
        const reqs: DrawRequest[] = [];
        let unknown = 0;
        for (const key of keys) {
            const x = key % GRID_SIZE, y = Math.floor(key / GRID_SIZE);
            // A chunk still loading shows an incomplete picture: painting there would
            // overwrite pixels the user has not seen yet
            if (this.knownColor(x, y) === null) unknown++;
            else reqs.push({ x, y, color: s.colorId });
        }
        if (unknown > 0) s.pushToast('info', 'Zone en cours de chargement', { detail: 'Les pixels hors zone chargée sont ignorés.', key: 'paint-unloaded' });
        if (reqs.length) this.queue.enqueue(reqs);
    }

    /**
     * Color of a pixel only when it is known to be current: its chunk is loaded AND kept
     * up to date by a live listener. A cached chunk catching up after a pan may still
     * show old values, which must not make a draw look like a no-op.
     */
    private knownColor(x: number, y: number): number | null {
        if (!this.sync?.isLive(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE))) return null;
        return this.engine.getPixel(x, y);
    }

    private placeSelected() {
        const s = useUIStore.getState();
        if (!s.selected || !s.placing) return;
        const { x, y } = s.selected;
        const res = this.queue.enqueue([{ x, y, color: s.colorId }]);
        if (res.queued === 0 && res.skipped > 0) {
            s.pushToast('info', 'Ce pixel a déjà cette couleur', { key: 'place-noop' });
        }
        s.cancelPlacing();
    }

    private onDrawError(kind: DrawErrorKind | 'unconfirmed' | 'queue_full', message: string, detail?: string) {
        if (this.destroyed) return;
        const toast = useUIStore.getState().pushToast;
        switch (kind) {
            case 'unauthorized':
                // The Discord token expired or was revoked: back to the login screen
                useAuthStore.getState().logout('Votre session Discord a expiré. Reconnectez-vous pour dessiner.');
                return;
            case 'forbidden':
                toast('error', 'Dessin refusé par la gateway', { detail: message || 'Clé API ou origine non autorisée.', key: 'draw-forbidden' });
                return;
            case 'bad_request':
                toast('warning', 'Pixel refusé', { detail: message, key: 'draw-bad' });
                return;
            case 'rate_limited':
                toast('warning', 'Trop de pixels d’un coup, envoi ralenti', { detail: message, key: 'draw-rate' });
                return;
            case 'unavailable':
            case 'network':
                toast('error', 'Pixels non envoyés après plusieurs essais', { detail: message, key: 'draw-unavailable' });
                return;
            case 'unconfirmed':
                toast('warning', message, { detail, key: 'draw-unconfirmed' });
                return;
            case 'queue_full':
                toast('warning', 'File d’envoi pleine', { detail: message, key: 'draw-full' });
                return;
            default:
                toast('error', 'Erreur lors du dessin', { detail: message, key: 'draw-unknown' });
        }
    }

    // --- Deep links: ?x=&y=&z= ---

    private initialView() {
        const params = new URLSearchParams(window.location.search);
        const x = Number(params.get('x')), y = Number(params.get('y')), z = Number(params.get('z'));
        if (params.has('x') && params.has('y') && isInGrid(Math.floor(x), Math.floor(y))) {
            this.engine.jumpTo(Math.floor(x) + 0.5, Math.floor(y) + 0.5, Number.isFinite(z) && z > 0 ? z : LINK_ZOOM);
        } else {
            this.engine.jumpTo(GRID_SIZE / 2, GRID_SIZE / 2, DEFAULT_ZOOM);
        }
    }

    private writeUrl(center: { x: number; y: number }, zoom: number) {
        clearTimeout(this.urlTimer);
        this.urlTimer = window.setTimeout(() => {
            if (this.destroyed) return;
            const params = new URLSearchParams(window.location.search);
            params.set('x', String(Math.floor(center.x)));
            params.set('y', String(Math.floor(center.y)));
            params.set('z', String(Math.round(zoom * 100) / 100));
            const url = `${window.location.pathname}?${params}${window.location.hash}`;
            window.history.replaceState(window.history.state, '', url);
        }, 300);
    }
}
