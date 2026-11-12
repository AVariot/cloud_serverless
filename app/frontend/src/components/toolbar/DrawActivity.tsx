import { Check, Loader2, Pause } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../store';
import { canvasCommands } from '../../runtime/bridge';
import { countLabel, formatCount } from '../../lib/format';

/**
 * Draw queue activity, shown as a strip at the top of the toolbar. It opens and
 * closes by animating its height so the rest of the toolbar never jumps.
 */
export function DrawActivity() {
    const { queued, inFlight, awaiting, paused } = useUIStore(
        useShallow((s) => ({
            queued: s.draw.queued,
            inFlight: s.draw.inFlight,
            awaiting: s.draw.awaiting,
            paused: s.draw.paused,
        })),
    );
    const sending = queued + inFlight;
    const visible = sending + awaiting > 0 || paused;

    let main;
    if (paused) {
        main = (
            <span className="inline-flex items-center gap-1.5 font-medium text-amber-300">
                <Pause size={14} aria-hidden="true" />
                En pause{sending > 0 && <span className="font-normal text-gray-300"> · {countLabel(sending, 'pixel')} en file</span>}
            </span>
        );
    } else if (sending > 0) {
        main = (
            <span className="inline-flex items-center gap-1.5 text-gray-100">
                <Loader2 size={14} className="animate-spin text-indigo-300" aria-hidden="true" />
                Envoi de {countLabel(sending, 'pixel')}…
            </span>
        );
    } else if (awaiting > 0) {
        main = (
            <span className="inline-flex items-center gap-1.5 text-gray-100">
                <Loader2 size={14} className="animate-spin text-indigo-300" aria-hidden="true" />
                {formatCount(awaiting)} en attente de confirmation
            </span>
        );
    } else {
        // Shown only while the strip collapses
        main = (
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <Check size={14} aria-hidden="true" />
                Envoyé
            </span>
        );
    }

    return (
        <div
            inert={!visible}
            className={
                'grid transition-[grid-template-rows,opacity] duration-200 ease-out ' +
                (visible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')
            }
        >
            <div className="min-h-0 overflow-hidden">
                <div className="mb-2 flex min-h-8 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-gray-700/70 px-2 pb-2 text-xs">
                    {main}
                    {awaiting > 0 && (sending > 0 || paused) && (
                        <span className="text-gray-300">{formatCount(awaiting)} en attente de confirmation</span>
                    )}
                    {queued > 0 && (
                        <button
                            type="button"
                            onClick={() => canvasCommands.cancelQueuedDraws()}
                            className="rounded-md px-1.5 py-0.5 font-medium text-red-300 underline-offset-2 transition-colors hover:bg-red-500/15 hover:text-red-200 hover:underline"
                        >
                            Annuler la file
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
