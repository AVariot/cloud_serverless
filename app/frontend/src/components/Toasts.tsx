import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useUIStore } from '../store';
import type { Toast, ToastKind } from '../types';

const DURATION_MS: Record<ToastKind, number> = { info: 4000, success: 4000, warning: 6000, error: 9000 };
/** Time left after hovering / focusing a toast that was about to expire */
const MIN_RESUME_MS = 1500;

const KIND: Record<ToastKind, { icon: typeof Info; color: string; label: string }> = {
    info: { icon: Info, color: 'text-sky-300', label: 'Information' },
    success: { icon: CheckCircle2, color: 'text-emerald-300', label: 'Succès' },
    warning: { icon: AlertTriangle, color: 'text-amber-300', label: 'Attention' },
    error: { icon: XCircle, color: 'text-red-300', label: 'Erreur' },
};

/** Notifications from store.toasts; newest last, auto-dismissed, paused while hovered or focused */
export function Toasts({ className = '', limit = Infinity }: { className?: string; limit?: number }) {
    const all = useUIStore((s) => s.toasts);
    const toasts = all.length > limit ? all.slice(-limit) : all;
    const lastError = findLast(all, (t) => t.kind === 'error');
    const lastOther = findLast(all, (t) => t.kind !== 'error');

    return (
        <>
            {/* Announcements go through two persistent live regions (polite / assertive):
                a live region on the list plus role="alert" on items would read errors twice */}
            <div className="sr-only" aria-live="polite">{lastOther ? announce(lastOther) : ''}</div>
            <div className="sr-only" aria-live="assertive">{lastError ? announce(lastError) : ''}</div>
            <ol aria-label="Notifications" className={`flex flex-col items-center gap-2 ${className}`}>
                {toasts.map((t) => (
                    <ToastItem key={t.id} toast={t} />
                ))}
            </ol>
        </>
    );
}

function findLast<T>(items: readonly T[], pred: (t: T) => boolean): T | undefined {
    for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return items[i];
    return undefined;
}

const announce = (t: Toast) => `${KIND[t.kind].label} : ${t.message}${t.detail ? `. ${t.detail}` : ''}`;

function ToastItem({ toast }: { toast: Toast }) {
    const dismissToast = useUIStore((s) => s.dismissToast);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const remaining = useRef(DURATION_MS[toast.kind]);
    const paused = hovered || focused;

    useEffect(() => {
        if (paused) return;
        const startedAt = Date.now();
        const timer = window.setTimeout(() => dismissToast(toast.id), remaining.current);
        return () => {
            window.clearTimeout(timer);
            remaining.current = Math.max(MIN_RESUME_MS, remaining.current - (Date.now() - startedAt));
        };
    }, [paused, toast.id, dismissToast]);

    const { icon: Icon, color, label } = KIND[toast.kind];

    return (
        <li
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
            }}
            className="pointer-events-auto flex w-full animate-toast-in items-start gap-3 rounded-xl border border-gray-700/80 bg-gray-900/95 py-2.5 pr-2 pl-3 shadow-xl shadow-black/30 backdrop-blur-md"
        >
            <Icon size={18} className={`mt-px shrink-0 ${color}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-gray-100">
                    <span className="sr-only">{label} : </span>
                    {toast.message}
                </p>
                {toast.detail && <p className="mt-0.5 break-words text-xs text-gray-400">{toast.detail}</p>}
            </div>
            <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                aria-label="Fermer la notification"
                title="Fermer"
                className="-my-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-700/70 hover:text-gray-100"
            >
                <X size={14} aria-hidden="true" />
            </button>
        </li>
    );
}
