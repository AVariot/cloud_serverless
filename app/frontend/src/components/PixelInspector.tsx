import { useId, type ReactNode } from 'react';
import { AlertTriangle, ExternalLink, Link2, LocateFixed, X } from 'lucide-react';
import { useUIStore } from '../store';
import { useAuthStore } from '../auth/store';
import { getAvatarUrl } from '../auth/discord';
import { canvasCommands } from '../runtime/bridge';
import { colorHex, colorLabel, EMPTY_COLOR_ID } from '../palette';
import { usePixelInfo } from '../hooks/usePixelInfo';
import { useNow } from '../hooks/useNow';
import { buildPixelLink, formatDateTime, formatRelativeTime } from '../lib/format';
import type { PixelInfo } from '../types';
import { IconButton } from './ui/IconButton';
import { cardIndent, cardRow, cardRowIcon } from './ui/styles';

const EMPTY_HEX = colorHex(EMPTY_COLOR_ID);

async function copyPixelLink(x: number, y: number) {
    const { zoom, pushToast } = useUIStore.getState();
    const url = buildPixelLink(window.location.origin, window.location.pathname, x, y, zoom);
    try {
        await navigator.clipboard.writeText(url);
        pushToast('success', 'Lien copié', { key: 'copy-link' });
    } catch {
        pushToast('error', 'Impossible de copier le lien', { detail: url, key: 'copy-link' });
    }
}

/**
 * Selected pixel section of the map card (select tool): live color, author and
 * date. Mounted once, so there is a single Firestore listener for it.
 */
export function PixelInspector({ compact = false }: { compact?: boolean }) {
    const selected = useUIStore((s) => (s.tool === 'select' ? s.selected : null));
    if (!selected) return null;
    return <PixelPanel x={selected.x} y={selected.y} compact={compact} />;
}

function PixelPanel({ x, y, compact }: { x: number; y: number; compact: boolean }) {
    const info = usePixelInfo(x, y);
    const clearSelection = useUIStore((s) => s.clearSelection);
    const titleId = useId();

    const swatch = info.status === 'ready' ? colorHex(info.color) : info.status === 'empty' ? EMPTY_HEX : null;

    return (
        <section
            aria-labelledby={titleId}
            aria-busy={info.status === 'loading'}
            className="animate-panel-in mt-0.5 border-t border-gray-700/70 pt-0.5"
        >
            <header className={cardRow}>
                <span className={cardRowIcon}>
                    {swatch ? (
                        <span aria-hidden="true" className="size-4 rounded ring-1 ring-white/25" style={{ backgroundColor: swatch }} />
                    ) : (
                        <span aria-hidden="true" className="size-4 animate-pulse rounded bg-gray-700" />
                    )}
                </span>
                <h2 id={titleId} className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="text-sm font-medium text-gray-100">Pixel</span>
                    <span className="truncate font-mono text-xs tabular-nums text-gray-400">
                        <span className="sr-only">x </span>
                        {x}
                        <span aria-hidden="true">, </span>
                        <span className="sr-only"> y </span>
                        {y}
                    </span>
                </h2>
                <div className="flex items-center">
                    <IconButton label="Copier le lien du pixel" icon={Link2} iconSize={15} onClick={() => void copyPixelLink(x, y)} />
                    <IconButton label="Centrer sur le pixel" icon={LocateFixed} iconSize={15} onClick={() => canvasCommands.flyTo(x, y)} />
                    <IconButton label="Fermer" shortcut="Échap" icon={X} iconSize={15} onClick={clearSelection} />
                </div>
            </header>

            {compact ? (
                // Short screens (landscape phones): one line, so the card leaves the
                // screen center (the selected pixel) visible
                <div className={`${cardIndent} -mt-1 truncate pb-2 text-xs text-gray-300`}>
                    <CompactDetails info={info} />
                </div>
            ) : (
                <div className={`${cardIndent} pb-3`}>
                    <PixelDetails info={info} />
                </div>
            )}
        </section>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="pt-0.5 text-xs text-gray-400">{label}</dt>
            <dd className="min-w-0 text-sm text-gray-100">{children}</dd>
        </>
    );
}

function PixelDetails({ info }: { info: PixelInfo }) {
    switch (info.status) {
        case 'loading':
            return (
                <div>
                    <div className="space-y-2 py-0.5" aria-hidden="true">
                        <div className="h-4 w-2/3 animate-pulse rounded bg-gray-700/80" />
                        <div className="h-4 w-5/6 animate-pulse rounded bg-gray-700/80" />
                        <div className="h-4 w-1/2 animate-pulse rounded bg-gray-700/80" />
                    </div>
                    <span className="sr-only">Chargement…</span>
                </div>
            );
        case 'empty':
            return (
                <p className="text-sm text-gray-300">Jamais dessiné</p>
            );
        case 'error':
            return (
                <div role="alert" className="flex items-start gap-2 text-sm text-red-300">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                        <p>Impossible de charger ce pixel.</p>
                        <p className="mt-0.5 break-words text-xs text-gray-400">{info.message}</p>
                    </div>
                </div>
            );
        case 'ready':
            return (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-1.5">
                    <Row label="Couleur">
                        <span className="flex items-baseline gap-2">
                            <span className="truncate">{colorLabel(info.color)}</span>
                            <span className="font-mono text-xs text-gray-400">{colorHex(info.color)}</span>
                        </span>
                    </Row>
                    <Row label="Auteur">
                        <Author userId={info.userId} />
                    </Row>
                    <Row label="Modifié">
                        <RelativeTime ms={info.updatedAtMs} />
                    </Row>
                </dl>
            );
    }
}

function CompactDetails({ info }: { info: PixelInfo }) {
    const me = useAuthStore((s) => s.user);
    switch (info.status) {
        case 'loading':
            return <span className="text-gray-400">Chargement…</span>;
        case 'empty':
            return <span>Jamais dessiné</span>;
        case 'error':
            return <span className="text-red-300">Impossible de charger ce pixel</span>;
        case 'ready':
            return (
                <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
                    <span>{colorLabel(info.color)}</span>
                    <span aria-hidden="true" className="text-gray-500">·</span>
                    <span className="truncate">{me && me.id === info.userId ? 'Vous' : `Discord ${info.userId}`}</span>
                    <span aria-hidden="true" className="text-gray-500">·</span>
                    <RelativeTime ms={info.updatedAtMs} />
                </span>
            );
    }
}

function Author({ userId }: { userId: string }) {
    const me = useAuthStore((s) => s.user);

    if (me && me.id === userId) {
        return (
            <span className="flex items-center gap-2">
                <img src={getAvatarUrl(me, 32)} alt="" className="size-4 rounded-full" />
                Vous
            </span>
        );
    }

    return (
        <span className="flex flex-col gap-0.5">
            <span>Utilisateur Discord</span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs">
                <span className="break-all font-mono text-gray-400">{userId}</span>
                <a
                    href={`https://discord.com/users/${encodeURIComponent(userId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded text-indigo-300 underline-offset-2 hover:text-indigo-200 hover:underline"
                >
                    Voir le profil
                    <ExternalLink size={12} aria-hidden="true" />
                    <span className="sr-only">(nouvel onglet)</span>
                </a>
            </span>
        </span>
    );
}

function RelativeTime({ ms }: { ms: number }) {
    const now = useNow();
    if (!Number.isFinite(ms)) return <span className="text-gray-400">Date inconnue</span>;
    return (
        <time dateTime={new Date(ms).toISOString()} title={formatDateTime(ms)}>
            {formatRelativeTime(ms, now)}
        </time>
    );
}
