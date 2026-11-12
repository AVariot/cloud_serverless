import { useEffect } from 'react';
import { useUIStore } from '../store';
import { canvasCommands } from '../runtime/bridge';

/** Zoom factor of one step (buttons and + / - keys) */
export const ZOOM_STEP = 1.5;

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Enter on these already activates them: never also place a pixel */
function isActivatable(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('button, a[href], summary, [role="button"], [role="link"]') !== null;
}

/**
 * Global keyboard shortcuts, mounted once by the app shell.
 *   V select tool · B brush · Esc cancel placing / clear selection · Enter place
 *   [ ] brush size · + = zoom in · - zoom out · F fit the whole map
 *
 * Ignored while typing in a field, when Ctrl/Cmd is held, and when another
 * handler already consumed the key (event.defaultPrevented, e.g. Escape closing
 * a popover). Letters also ignore Alt; symbols accept AltGr/Option so that
 * [ and ] work on French AZERTY keyboards (AltGr+5 / AltGr+°).
 */
export function useShortcuts() {
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing || e.metaKey) return;
            if (isEditableTarget(e.target)) return;
            const altGraph = e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey);
            if (e.ctrlKey && !altGraph) return;
            const plainKey = !e.ctrlKey && !e.altKey;

            const s = useUIStore.getState();
            switch (e.key) {
                case 'v':
                case 'V':
                    if (!plainKey) return;
                    s.setTool('select');
                    break;
                case 'b':
                case 'B':
                    if (!plainKey) return;
                    s.setTool('brush');
                    break;
                case 'f':
                case 'F':
                    if (!plainKey) return;
                    canvasCommands.fitToMap();
                    break;
                case 'Escape':
                    if (s.placing) s.cancelPlacing();
                    else if (s.selected) s.clearSelection();
                    else return;
                    break;
                case 'Enter':
                    if (!s.placing || e.repeat || isActivatable(e.target)) return;
                    canvasCommands.placeSelected();
                    break;
                case '[':
                    s.setBrushSize(s.brushSize - 1);
                    break;
                case ']':
                    s.setBrushSize(s.brushSize + 1);
                    break;
                case '+':
                case '=':
                    canvasCommands.zoomBy(ZOOM_STEP);
                    break;
                case '-':
                case '_':
                    canvasCommands.zoomBy(1 / ZOOM_STEP);
                    break;
                default:
                    return;
            }
            e.preventDefault();
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);
}
