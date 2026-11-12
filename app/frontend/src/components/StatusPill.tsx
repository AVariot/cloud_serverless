import { Fragment, useCallback, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../store';
import { useDismiss } from '../hooks/useDismiss';
import { countLabel, formatCount } from '../lib/format';
import type { SyncStatus } from '../types';
import { panel } from './ui/styles';

const STATUS: Record<SyncStatus, { label: string; dot: string }> = {
    live: { label: 'En direct', dot: 'bg-emerald-400' },
    connecting: { label: 'Connexion…', dot: 'bg-amber-400 animate-pulse' },
    offline: { label: 'Hors ligne', dot: 'bg-red-400' },
    error: { label: 'Reconnexion…', dot: 'bg-red-400' },
};

/**
 * Real-time sync status with a details panel (opens on hover with a mouse, or
 * stays open on click / tap; Escape or a click outside closes it).
 */
export function StatusPill() {
    const { status, loading, error } = useUIStore(
        useShallow((s) => ({ status: s.sync.status, loading: s.sync.loading, error: s.sync.error })),
    );
    const [pinned, setPinned] = useState(false);
    const [hovered, setHovered] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const panelId = useId();
    const unpin = useCallback(() => setPinned(false), []);
    useDismiss(containerRef, pinned, unpin);

    const open = pinned || hovered;
    const meta = STATUS[status];

    return (
        <div
            ref={containerRef}
            className="relative"
            onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setHovered(false)}
        >
            <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                title={status === 'error' && error ? error : undefined}
                onClick={() => setPinned((p) => !p)}
                className={`${panel} pointer-events-auto inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium whitespace-nowrap text-gray-100 transition-colors hover:border-gray-600`}
            >
                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${meta.dot}`} />
                {meta.label}
                {loading > 0 && (
                    <span className="inline-flex items-center gap-1.5 border-l border-gray-700 pl-2 font-normal text-gray-300">
                        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                        Chargement de {countLabel(loading, 'zone')}
                    </span>
                )}
            </button>

            <div className={open ? 'pointer-events-auto absolute top-full left-0 z-30 pt-2' : 'hidden'}>
                <div id={panelId} role="region" aria-label="Détails de la synchronisation" className={`${panel} w-60 p-3`}>
                    {open && <SyncDetails />}
                </div>
            </div>
        </div>
    );
}

function SyncDetails() {
    const sync = useUIStore((s) => s.sync);
    const rows: [string, number][] = [
        ['Zones chargées', sync.loaded],
        ['Zones en direct', sync.live],
        ['Écouteurs', sync.listeners],
        ['Documents lus', sync.docsRead],
    ];

    return (
        <>
            <p className="mb-2 text-xs font-medium text-gray-200">Synchronisation</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
                {rows.map(([label, value]) => (
                    <Fragment key={label}>
                        <dt className="text-gray-400">{label}</dt>
                        <dd className="text-right font-mono tabular-nums text-gray-100">{formatCount(value)}</dd>
                    </Fragment>
                ))}
            </dl>
            {sync.error && (
                <p className="mt-2 border-t border-gray-700/70 pt-2 text-xs break-words text-red-300">{sync.error}</p>
            )}
        </>
    );
}
