import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

/** Non-blocking warning listing the VITE_* settings missing from the build */
export function EnvBanner({ missing }: { missing: readonly string[] }) {
    const [hidden, setHidden] = useState(false);
    if (hidden || missing.length === 0) return null;

    return (
        <div
            role="status"
            className="pointer-events-auto mx-auto flex w-full max-w-2xl items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-950/95 py-2.5 pr-2 pl-3 text-amber-100 shadow-xl shadow-black/30 backdrop-blur-md"
        >
            <AlertTriangle size={18} className="mt-px shrink-0 text-amber-300" aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">Configuration incomplète</p>
                <p className="mt-0.5 text-xs text-amber-200/90">
                    {missing.length > 1 ? 'Variables manquantes' : 'Variable manquante'} :{' '}
                    {missing.map((name, i) => (
                        <span key={name}>
                            {i > 0 && ', '}
                            <code className="font-mono break-all">{name}</code>
                        </span>
                    ))}
                    . Le dessin ou la synchronisation peuvent ne pas fonctionner.
                </p>
            </div>
            <button
                type="button"
                onClick={() => setHidden(true)}
                aria-label="Masquer l’avertissement"
                title="Masquer"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-amber-200 transition-colors hover:bg-amber-500/20 hover:text-white"
            >
                <X size={14} aria-hidden="true" />
            </button>
        </div>
    );
}
