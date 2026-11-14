import { useCallback, useId, useRef, useState } from 'react';
import { Crosshair, Maximize, Minus, Navigation, Plus, ZoomIn } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../store';
import { GRID_SIZE } from '../config';
import { canvasCommands } from '../runtime/bridge';
import { ZOOM_STEP } from '../hooks/useShortcuts';
import { formatZoom } from '../lib/format';
import { GoToPixel } from './GoToPixel';
import { PixelInspector } from './PixelInspector';
import { IconButton } from './ui/IconButton';
import { cardRow, cardRowIcon, fieldLabel, panel } from './ui/styles';

const COORD_WIDTH = `${String(GRID_SIZE - 1).length}ch`;

/**
 * Top-left card, one row per concern, all on the same grid (icon column,
 * content, actions on the right):
 *
 *   [+] X 5000   Y 5000            [Aller à]      position (cursor, else selection)
 *   [Q] [-]  2000 %  [+]           [Carte]        zoom
 *   ---------------------------------------
 *   [#] Pixel  27, 12        [lien][centrer][x]   selected pixel, details below
 *
 * Only CoordinateReadout reads `hover`, so mouse moves re-render nothing else.
 */
export function MapCard({ compact = false }: { compact?: boolean }) {
    const [goToOpen, setGoToOpen] = useState(false);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const formId = useId();

    const closeGoTo = useCallback(() => {
        setGoToOpen(false);
        // The toggle is mounted again by this render: focus it right after
        requestAnimationFrame(() => toggleRef.current?.focus());
    }, []);

    return (
        <div className={`${panel} pointer-events-auto w-72 max-w-full overflow-hidden py-0.5`}>
            {goToOpen ? (
                <GoToPixel id={formId} onClose={closeGoTo} />
            ) : (
                <div className={cardRow}>
                    <span className={cardRowIcon} title="Position">
                        <Crosshair size={16} aria-hidden="true" />
                    </span>
                    <CoordinateReadout />
                    <IconButton
                        ref={toggleRef}
                        label="Aller à un pixel"
                        icon={Navigation}
                        iconSize={15}
                        onClick={() => setGoToOpen(true)}
                    />
                </div>
            )}
            <ZoomRow />
            <PixelInspector compact={compact} />
        </div>
    );
}

function CoordinateReadout() {
    const point = useUIStore(useShallow((s) => s.hover ?? s.selected));

    return (
        <p className="flex min-w-0 flex-1 items-baseline gap-4 font-mono text-sm tabular-nums text-gray-100">
            <span className="sr-only">Position :</span>
            <span className="flex items-baseline gap-1.5">
                <span className={fieldLabel}>X</span>
                <span className="inline-block" style={{ minWidth: COORD_WIDTH }}>
                    {point?.x ?? '–'}
                </span>
            </span>
            <span className="flex items-baseline gap-1.5">
                <span className={fieldLabel}>Y</span>
                <span className="inline-block" style={{ minWidth: COORD_WIDTH }}>
                    {point?.y ?? '–'}
                </span>
            </span>
        </p>
    );
}

function ZoomRow() {
    const zoom = useUIStore((s) => s.zoom);

    return (
        <div role="group" aria-label="Zoom" className={cardRow}>
            <span className={cardRowIcon} title="Zoom">
                <ZoomIn size={16} aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-1 items-center">
                <IconButton label="Dézoomer" shortcut="-" icon={Minus} className="-ml-2" onClick={() => canvasCommands.zoomBy(1 / ZOOM_STEP)} />
                <span className="min-w-[7ch] text-center font-mono text-sm tabular-nums text-gray-100">{formatZoom(zoom)}</span>
                <IconButton label="Zoomer" shortcut="+" icon={Plus} onClick={() => canvasCommands.zoomBy(ZOOM_STEP)} />
            </div>
            <IconButton label="Voir toute la carte" shortcut="F" icon={Maximize} iconSize={15} onClick={() => canvasCommands.fitToMap()} />
        </div>
    );
}
