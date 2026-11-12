import { useSyncExternalStore } from 'react';

const TICK_MS = 15_000;

// One shared clock for every relative time on screen
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
    listeners.add(listener);
    // Fresh value for the first subscriber after an idle period; React re-reads the snapshot after subscribing
    now = Date.now();
    timer ??= setInterval(() => {
        now = Date.now();
        listeners.forEach((l) => l());
    }, TICK_MS);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };
}

const getSnapshot = () => now;

/** Current time in ms, refreshed every 15 s (for "il y a 3 min" labels) */
export function useNow(): number {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
