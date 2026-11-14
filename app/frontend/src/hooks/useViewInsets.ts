import { useEffect, type RefObject } from 'react';
import { useUIStore } from '../store';

/**
 * Reports how much of the screen the floating panels cover (top stack and bottom
 * toolbar/inspector) so the engine centers fly-to targets in the visible area.
 */
export function useViewInsets(topRef: RefObject<HTMLElement | null>, bottomRef: RefObject<HTMLElement | null>) {
    useEffect(() => {
        const top = topRef.current, bottom = bottomRef.current;
        if (!top || !bottom) return;
        let frame = 0;
        const measure = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const t = top.getBoundingClientRect().bottom;
                const b = window.innerHeight - bottom.getBoundingClientRect().top;
                useUIStore.getState().setViewInsets(t, b);
            });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(top);
        observer.observe(bottom);
        window.addEventListener('resize', measure);
        measure();
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [topRef, bottomRef]);
}
