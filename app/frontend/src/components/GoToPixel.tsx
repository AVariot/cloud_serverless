import { useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Navigation, X } from 'lucide-react';
import { useUIStore } from '../store';
import { canvasCommands } from '../runtime/bridge';
import { IconButton } from './ui/IconButton';
import { cardIndent, cardRow, cardRowIcon, fieldLabel } from './ui/styles';
import { formatCount, MAX_COORD, parseCoordinate, splitCoordinatePair, type CoordinateError } from '../lib/format';

type Errors = { x?: CoordinateError; y?: CoordinateError };

function errorMessage(errors: Errors): string {
    const kinds = [errors.x, errors.y];
    if (kinds.includes('empty')) return 'Indiquez x et y.';
    if (kinds.includes('format')) return 'Nombres entiers uniquement.';
    return `Coordonnées de 0 à ${formatCount(MAX_COORD)}.`;
}

const inputClass = (invalid: boolean) =>
    'h-8 w-14 min-w-0 rounded-lg border bg-gray-950/80 px-2 font-mono text-sm tabular-nums text-gray-100 placeholder:text-gray-600 ' +
    'transition-colors focus:border-indigo-400 ' +
    (invalid ? 'border-red-400' : 'border-gray-600 hover:border-gray-500');

/**
 * "Aller à" form: replaces the position row of the map card. Two fields (pasting "x, y" in either one fills both). Flies to
 * the pixel and selects it when the select tool is active.
 */
export function GoToPixel({ id, onClose }: { id: string; onClose: () => void }) {
    const [xText, setXText] = useState('');
    const [yText, setYText] = useState('');
    const [errors, setErrors] = useState<Errors | null>(null);
    const xRef = useRef<HTMLInputElement>(null);
    const yRef = useRef<HTMLInputElement>(null);
    const xId = useId();
    const yId = useId();
    const errorId = useId();

    const change = (value: string, set: (v: string) => void) => {
        const pair = splitCoordinatePair(value);
        if (pair) {
            setXText(pair[0]);
            setYText(pair[1]);
        } else {
            set(value);
        }
        setErrors(null);
    };

    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const px = parseCoordinate(xText);
        const py = parseCoordinate(yText);
        if (!px.ok || !py.ok) {
            setErrors({ x: px.ok ? undefined : px.error, y: py.ok ? undefined : py.error });
            (px.ok ? yRef : xRef).current?.focus();
            return;
        }
        canvasCommands.flyTo(px.value, py.value);
        const s = useUIStore.getState();
        if (s.tool === 'select') s.select(px.value, py.value);
        onClose();
    };

    const describedBy = errors ? errorId : undefined;

    return (
        <form
            id={id}
            noValidate
            aria-label="Aller à un pixel"
            onSubmit={submit}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    onClose();
                }
            }}
            className="animate-panel-in"
        >
            <div className={cardRow}>
                <span className={`${cardRowIcon} text-indigo-300`}>
                    <Navigation size={15} aria-hidden="true" />
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <label htmlFor={xId} className={fieldLabel}>
                        X
                    </label>
                    <input
                        ref={xRef}
                        id={xId}
                        autoFocus
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="0"
                        value={xText}
                        onChange={(e) => change(e.target.value, setXText)}
                        aria-invalid={Boolean(errors?.x)}
                        aria-describedby={describedBy}
                        className={inputClass(Boolean(errors?.x))}
                    />
                    <label htmlFor={yId} className={`${fieldLabel} ml-1.5`}>
                        Y
                    </label>
                    <input
                        ref={yRef}
                        id={yId}
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="0"
                        value={yText}
                        onChange={(e) => change(e.target.value, setYText)}
                        aria-invalid={Boolean(errors?.y)}
                        aria-describedby={describedBy}
                        className={inputClass(Boolean(errors?.y))}
                    />
                </div>
                <button
                    type="submit"
                    aria-label="Aller"
                    title="Aller (Entrée)"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition-colors hover:bg-indigo-500 active:bg-indigo-700"
                >
                    <ArrowRight size={16} aria-hidden="true" />
                </button>
                <IconButton label="Annuler" shortcut="Échap" icon={X} onClick={onClose} />
            </div>
            {errors && (
                <p id={errorId} role="alert" className={`${cardIndent} -mt-1 pb-2 text-xs text-red-300`}>
                    {errorMessage(errors)}
                </p>
            )}
        </form>
    );
}
