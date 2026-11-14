import { useEffect, useState } from 'react';
import { watchPixel } from '../data/pixelDoc';
import type { PixelInfo } from '../types';

const LOADING: PixelInfo = { status: 'loading' };

/**
 * Live Firestore content of one pixel (author, time, color). Subscribes while
 * mounted and re-subscribes when the coordinates change; until the new pixel's
 * first answer arrives it reports { status: 'loading' }.
 */
export function usePixelInfo(x: number, y: number): PixelInfo {
    const key = `${x}_${y}`;
    const [state, setState] = useState<{ key: string; info: PixelInfo }>({ key, info: LOADING });

    useEffect(() => {
        let active = true;
        const unsubscribe = watchPixel(x, y, (info) => {
            if (active) setState({ key: `${x}_${y}`, info });
        });
        return () => {
            active = false;
            unsubscribe();
        };
    }, [x, y]);

    // Stale answer from the previous pixel: show loading instead
    return state.key === key ? state.info : LOADING;
}
