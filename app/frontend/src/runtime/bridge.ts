// Imperative commands the UI sends to the canvas runtime (camera moves, drawing).
// The runtime registers itself while mounted; calls are no-ops otherwise.

export interface CanvasCommands {
    /** Smoothly centers the camera on a pixel; zoom defaults to a close-up level */
    flyTo(x: number, y: number, zoom?: number): void;
    /** Shows the whole grid */
    fitToMap(): void;
    /** Multiplies the zoom around the screen center */
    zoomBy(factor: number): void;
    /** Sends the selected pixel with the current color (select tool, placing mode) */
    placeSelected(): void;
    /** Drops every queued (not yet sent) pixel */
    cancelQueuedDraws(): void;
}

let current: CanvasCommands | null = null;

export function registerCanvasCommands(commands: CanvasCommands | null) {
    current = commands;
}

export const canvasCommands: CanvasCommands = {
    flyTo: (x, y, zoom) => current?.flyTo(x, y, zoom),
    fitToMap: () => current?.fitToMap(),
    zoomBy: (factor) => current?.zoomBy(factor),
    placeSelected: () => current?.placeSelected(),
    cancelQueuedDraws: () => current?.cancelQueuedDraws(),
};
