import { useId } from 'react';
import { Circle, Square, ZoomIn } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE, useUIStore } from '../../store';
import { countLabel } from '../../lib/format';
import { MIN_PAINT_ZOOM } from '../../config';
import { canvasCommands } from '../../runtime/bridge';
import type { BrushShape } from '../../types';
import { segment, segmented } from '../ui/styles';

const SHAPES: readonly { id: BrushShape; label: string; icon: typeof Square }[] = [
    { id: 'square', label: 'Carré', icon: Square },
    { id: 'round', label: 'Rond', icon: Circle },
];

const SIZE_HINT = 'Taille du pinceau ([ et ])';

/** Brush size slider and square / round toggle (brush tool only) */
export function BrushControls() {
    const { size, shape } = useUIStore(useShallow((s) => ({ size: s.brushSize, shape: s.brushShape })));
    const setBrushSize = useUIStore((s) => s.setBrushSize);
    const setBrushShape = useUIStore((s) => s.setBrushShape);
    const sliderId = useId();
    // Boolean selector: re-renders only when crossing the threshold, not on every zoom step
    const tooFar = useUIStore((s) => s.zoom < MIN_PAINT_ZOOM);

    if (tooFar) {
        return (
            <button
                type="button"
                onClick={() => canvasCommands.zoomBy((MIN_PAINT_ZOOM * 2) / useUIStore.getState().zoom)}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-amber-200 hover:bg-gray-800 hover:text-amber-100"
            >
                <ZoomIn size={14} aria-hidden="true" />
                Zoomez pour dessiner
            </button>
        );
    }

    return (
        <div className="flex items-center gap-3">
            <label htmlFor={sliderId} title={SIZE_HINT} className="whitespace-nowrap text-xs text-gray-300">
                Taille{' '}
                <span className="inline-block w-[2ch] text-right font-semibold tabular-nums text-gray-100">{size}</span>
            </label>
            <input
                id={sliderId}
                type="range"
                min={MIN_BRUSH_SIZE}
                max={MAX_BRUSH_SIZE}
                step={1}
                value={size}
                title={SIZE_HINT}
                aria-valuetext={countLabel(size, 'pixel')}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="h-1.5 w-24 cursor-pointer accent-indigo-500 sm:w-32"
            />
            <div role="group" aria-label="Forme du pinceau" className={segmented}>
                {SHAPES.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={shape === id}
                        aria-label={label}
                        title={`Pinceau ${label.toLowerCase()}`}
                        onClick={() => setBrushShape(id)}
                        className={`${segment(shape === id)} size-7`}
                    >
                        <Icon size={14} aria-hidden="true" />
                    </button>
                ))}
            </div>
        </div>
    );
}
