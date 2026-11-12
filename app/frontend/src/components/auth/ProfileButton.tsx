import { useCallback, useId, useRef, useState } from 'react';
import { Check, Copy, LogOut } from 'lucide-react';
import { useAuthStore } from '../../auth/store';
import { getAvatarUrl, type DiscordUser } from '../../auth/discord';
import { tokenExpiresAt } from '../../auth/token';
import { useDismiss } from '../../hooks/useDismiss';
import { panel } from '../ui/styles';

const expiryFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// The panel is inset by this padding around the avatar, so the avatar stays exactly
// where it was and the panel seems to grow out of it
const PAD = 'p-1.5';
const PAD_OFFSET = '-top-1.5 -right-1.5';

/**
 * Avatar (top right). A click opens the account panel around the avatar itself:
 * name, username, Discord id (the one shown as author in the pixel inspector),
 * session expiry and logout. Takes a fixed 40x40 slot: the other panels never move.
 */
export function ProfileButton() {
    const user = useAuthStore((s) => s.user);
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    const close = useCallback(() => setOpen(false), []);
    useDismiss(containerRef, open, close);

    if (!user) return null;

    return (
        <div ref={containerRef} className="pointer-events-auto relative size-10">
            {open && (
                <ProfilePanel
                    id={panelId}
                    user={user}
                    onClose={() => {
                        close();
                        buttonRef.current?.focus();
                    }}
                />
            )}
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-label="Profil"
                title={open ? 'Fermer le profil' : 'Profil'}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                className={
                    'relative z-10 block size-10 rounded-full ring-2 transition ' +
                    (open ? 'ring-gray-600' : 'shadow-xl shadow-black/30 ring-gray-700/80 hover:ring-gray-500')
                }
            >
                <img src={getAvatarUrl(user, 64)} alt="" className="size-10 rounded-full" />
            </button>
        </div>
    );
}

function ProfilePanel({ id, user, onClose }: { id: string; user: DiscordUser; onClose: () => void }) {
    const logout = useAuthStore((s) => s.logout);
    const [copied, setCopied] = useState(false);
    const titleId = useId();
    const displayName = user.global_name || user.username;
    const expiresAt = tokenExpiresAt();

    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(user.id);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard refused: the id stays selectable
        }
    };

    return (
        <section
            id={id}
            aria-labelledby={titleId}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    onClose();
                }
            }}
            className={`${panel} absolute ${PAD_OFFSET} w-60 max-w-[calc(100vw-1.5rem)] origin-top-right animate-profile-in ${PAD}`}
        >
            {/* Header: identity on the left, the slot on the right is the avatar button itself */}
            <div className="flex h-10 items-center pr-12 pl-1.5">
                <div className="min-w-0">
                    <h2 id={titleId} className="truncate text-sm leading-5 font-medium text-gray-100" title={displayName}>
                        {displayName}
                    </h2>
                    <p className="truncate text-xs leading-4 text-gray-400" title={`@${user.username}`}>
                        @{user.username}
                    </p>
                </div>
            </div>

            <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t border-gray-700/70 px-1.5 pt-2 pb-1 text-xs">
                <dt className="text-gray-400">ID</dt>
                <dd className="flex min-w-0 items-center justify-end gap-0.5">
                    <span className="truncate font-mono text-gray-200 select-all">{user.id}</span>
                    <button
                        type="button"
                        onClick={() => void copyId()}
                        aria-label={copied ? 'Identifiant copié' : 'Copier l’identifiant'}
                        title={copied ? 'Copié' : 'Copier l’identifiant'}
                        className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-700/70 hover:text-white"
                    >
                        {copied ? <Check size={13} aria-hidden="true" className="text-emerald-400" /> : <Copy size={13} aria-hidden="true" />}
                    </button>
                </dd>
                {expiresAt !== null && (
                    <>
                        <dt className="text-gray-400">Session</dt>
                        <dd className="h-6 truncate text-right leading-6 text-gray-200">
                            <time dateTime={new Date(expiresAt).toISOString()}>jusqu’au {expiryFormat.format(expiresAt)}</time>
                        </dd>
                    </>
                )}
            </dl>

            <div className="mt-1 border-t border-gray-700/70 pt-1">
                <button
                    type="button"
                    onClick={() => logout()}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
                >
                    <LogOut size={14} aria-hidden="true" />
                    Se déconnecter
                </button>
            </div>
        </section>
    );
}
