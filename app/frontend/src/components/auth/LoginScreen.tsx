import React from 'react';
import { useAuthStore } from '../../auth/store';
import { PALETTE } from '../../palette';
import { DiscordIcon } from '../icons/DiscordIcon';

/** Small mosaic of the palette colors, used as the logo */
function PaletteMark() {
    return (
        <div aria-hidden="true" className="grid grid-cols-4 gap-1 rounded-xl border border-gray-700 bg-gray-950 p-2">
            {PALETTE.slice(0, 16).map((c) => (
                <span key={c.id} className="size-3 rounded-[3px]" style={{ backgroundColor: c.hex }} />
            ))}
        </div>
    );
}

export const LoginScreen: React.FC = () => {
    const login = useAuthStore((s) => s.login);
    const error = useAuthStore((s) => s.error);

    return (
        <main className="flex h-full w-full items-center justify-center overflow-y-auto bg-gray-950 px-4 font-sans">
            <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border border-gray-700 bg-gray-900/80 p-8 text-center shadow-2xl backdrop-blur">
                <PaletteMark />
                <div className="space-y-2">
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-100">ServTkt r/place</h1>
                </div>
                <button
                    type="button"
                    onClick={login}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#5865F2] px-5 py-3 font-medium text-white shadow-lg transition-colors hover:bg-[#4752C4] active:scale-[0.98]"
                >
                    <DiscordIcon size={20} /> Se connecter avec Discord
                </button>
                {error && (
                    <p role="alert" className="text-sm break-words text-red-400">
                        {error}
                    </p>
                )}
            </div>
        </main>
    );
};
