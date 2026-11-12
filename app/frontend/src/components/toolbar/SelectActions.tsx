import { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../store';
import { canvasCommands } from '../../runtime/bridge';
import { colorHex, colorLabel } from '../../palette';
import { kbd, primaryButton, secondaryButton, swatchEdge } from '../ui/styles';

function ColorDot({ colorId, className = '' }: { colorId: number; className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={`inline-block size-4 shrink-0 rounded-full inset-ring-1 inset-ring-white/40 ${className}`}
            style={{ backgroundColor: colorHex(colorId) }}
        />
    );
}

/** Select tool: usage hint, "Placer un pixel", then Annuler / Valider while placing */
export function SelectActions() {
    const { hasSelection, placing, colorId } = useUIStore(
        useShallow((s) => ({ hasSelection: s.selected !== null, placing: s.placing, colorId: s.colorId })),
    );
    const startPlacing = useUIStore((s) => s.startPlacing);
    const cancelPlacing = useUIStore((s) => s.cancelPlacing);
    const primaryRef = useRef<HTMLButtonElement>(null);
    const handOff = useRef(false);

    // The activated button unmounts when the step changes: if focus fell back to the page,
    // hand it to the new primary action so keyboard users keep their place. Only after one
    // of these buttons was used: a click on the canvas must not move focus here.
    useEffect(() => {
        if (!handOff.current) return;
        handOff.current = false;
        if (document.activeElement === document.body || document.activeElement === null) primaryRef.current?.focus();
    }, [placing, hasSelection]);

    if (!hasSelection) {
        return (
            <p className="max-w-md text-center text-xs leading-4 text-gray-300">
                <span className="pointer-coarse:hidden">
                    Cliquez sur un pixel pour l’inspecter · glissez pour vous déplacer · molette pour zoomer
                </span>
                <span className="hidden pointer-coarse:inline">
                    Touchez un pixel pour l’inspecter · glissez pour vous déplacer · pincez pour zoomer
                </span>
            </p>
        );
    }

    if (!placing) {
        return (
            <button ref={primaryRef} type="button" onClick={() => { handOff.current = true; startPlacing(); }} className={primaryButton}>
                <ColorDot colorId={colorId} />
                Placer un pixel
            </button>
        );
    }

    return (
        <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="hidden items-center gap-1.5 pr-1 text-xs text-gray-300 sm:inline-flex">
                <ColorDot colorId={colorId} className={swatchEdge} />
                {colorLabel(colorId)}
            </span>
            <button type="button" onClick={() => { handOff.current = true; cancelPlacing(); }} title="Annuler (Échap)" className={secondaryButton}>
                <X size={16} aria-hidden="true" />
                Annuler
                <kbd className={kbd}>Échap</kbd>
            </button>
            <button
                ref={primaryRef}
                type="button"
                onClick={() => { handOff.current = true; canvasCommands.placeSelected(); }}
                title="Valider (Entrée)"
                className={primaryButton}
            >
                <Check size={16} aria-hidden="true" />
                Valider
                <kbd className={kbd}>Entrée</kbd>
            </button>
        </div>
    );
}
