import { create } from 'zustand';
import { DEFAULT_COLOR_ID, isDrawableColor } from './palette';
import { isInGrid } from './config';
import type { BrushShape, DrawStats, SyncStats, Toast, ToastKind, Tool } from './types';

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 16;
const TOAST_LIMIT = 4;

export interface UIState {
    // Camera feedback (written by the engine)
    hover: { x: number; y: number } | null;
    zoom: number;

    // Tools
    tool: Tool;
    colorId: number;
    brushSize: number;
    brushShape: BrushShape;

    // Select tool: inspected pixel, and whether the user is placing a color on it
    selected: { x: number; y: number } | null;
    placing: boolean;

    // Pipelines (written by the runtime)
    sync: SyncStats;
    draw: DrawStats;

    toasts: Toast[];

    /** Screen space covered by the floating panels (CSS px): fly-to targets are centered between them */
    viewInsets: { top: number; bottom: number };

    setHover: (p: { x: number; y: number } | null) => void;
    setZoom: (zoom: number) => void;
    setTool: (tool: Tool) => void;
    setColor: (id: number) => void;
    setBrushSize: (size: number) => void;
    setBrushShape: (shape: BrushShape) => void;
    select: (x: number, y: number) => void;
    clearSelection: () => void;
    startPlacing: () => void;
    cancelPlacing: () => void;
    setSync: (sync: SyncStats) => void;
    setDraw: (draw: DrawStats) => void;
    pushToast: (kind: ToastKind, message: string, opts?: { detail?: string; key?: string }) => number;
    dismissToast: (id: number) => void;
    setViewInsets: (top: number, bottom: number) => void;
}

let nextToastId = 1;

export const clampBrushSize = (size: number) =>
    Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, Math.round(Number.isFinite(size) ? size : MIN_BRUSH_SIZE)));

export const useUIStore = create<UIState>((set, get) => ({
    hover: null,
    zoom: 1,

    tool: 'select',
    colorId: DEFAULT_COLOR_ID,
    brushSize: 3,
    brushShape: 'square',

    selected: null,
    placing: false,

    sync: { status: 'connecting', needed: 0, loading: 0, loaded: 0, live: 0, listeners: 0, docsRead: 0 },
    draw: { queued: 0, inFlight: 0, awaiting: 0, confirmed: 0, failed: 0, unconfirmed: 0, paused: false },

    toasts: [],

    viewInsets: { top: 0, bottom: 0 },

    setHover: (p) => {
        const cur = get().hover;
        if (cur === p || (cur && p && cur.x === p.x && cur.y === p.y)) return;
        set({ hover: p });
    },
    setZoom: (zoom) => {
        if (get().zoom !== zoom) set({ zoom });
    },
    setTool: (tool) => {
        if (get().tool === tool) return;
        // Switching to the brush ends the single-pixel workflow
        set(tool === 'brush' ? { tool, selected: null, placing: false } : { tool });
    },
    setColor: (id) => {
        if (isDrawableColor(id)) set({ colorId: id });
    },
    setBrushSize: (size) => set({ brushSize: clampBrushSize(size) }),
    setBrushShape: (brushShape) => set({ brushShape }),
    select: (x, y) => {
        if (!isInGrid(x, y)) return;
        const cur = get().selected;
        // Re-selecting the same pixel keeps the placing state
        if (cur && cur.x === x && cur.y === y) return;
        set({ selected: { x, y }, placing: false });
    },
    clearSelection: () => set({ selected: null, placing: false }),
    startPlacing: () => {
        if (get().selected) set({ placing: true });
    },
    cancelPlacing: () => set({ placing: false }),
    setSync: (sync) => set({ sync }),
    setDraw: (draw) => set({ draw }),
    pushToast: (kind, message, opts) => {
        const id = nextToastId++;
        const toast: Toast = { id, kind, message, detail: opts?.detail, key: opts?.key };
        set((s) => {
            const rest = opts?.key ? s.toasts.filter((t) => t.key !== opts.key) : s.toasts;
            return { toasts: [...rest, toast].slice(-TOAST_LIMIT) };
        });
        return id;
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setViewInsets: (top, bottom) => {
        const cur = get().viewInsets;
        top = Math.max(0, Math.round(top));
        bottom = Math.max(0, Math.round(bottom));
        if (cur.top !== top || cur.bottom !== bottom) set({ viewInsets: { top, bottom } });
    },
}));
