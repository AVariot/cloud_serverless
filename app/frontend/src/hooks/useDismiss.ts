import { useEffect, type RefObject } from 'react';

/**
 * Closes a popover on a pointer press outside `ref` or on Escape, while `active`.
 * Escape is marked as handled (preventDefault) so the global shortcuts skip it.
 * `onDismiss` must be stable (useCallback or a state setter wrapper).
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void) {
    useEffect(() => {
        if (!active) return;
        const onPointerDown = (e: PointerEvent) => {
            if (!ref.current?.contains(e.target as Node)) onDismiss();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            onDismiss();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [ref, active, onDismiss]);
}
