import { CanvasBoard } from './components/CanvasBoard';
import { Toolbar } from './components/Toolbar';
import { MapCard } from './components/MapCard';
import { Toasts } from './components/Toasts';
import { EnvBanner } from './components/EnvBanner';
import { AuthGate } from './components/auth/AuthGate';
import { ProfileButton } from './components/auth/ProfileButton';
import { useShortcuts } from './hooks/useShortcuts';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useViewInsets } from './hooks/useViewInsets';
import { useRef } from 'react';
import { missingEnv } from './config';

// Build-time settings: computed once
const MISSING_ENV = missingEnv();

export default function App() {
    return (
        <AuthGate>
            <Shell />
        </AuthGate>
    );
}

/**
 * Full-screen canvas with floating panels. Wrappers are pointer-events-none so
 * drags and wheel reach the canvas everywhere except on the panels themselves.
 *
 *   phone (< md)                 tablet (md)                    desktop (lg+)
 *   [map card      ] [profile]   [map card] [toasts, profile]   [map card] [toasts] [profile]
 *   [toasts                  ]
 *   ...canvas...                 ...canvas...                   ...canvas...
 *   [toolbar                 ]          [toolbar]                       [toolbar]
 *
 * The map card (top left) groups coordinates, "Aller à", zoom and the selected
 * pixel's details, so the screen center (where the selected pixel is flown to)
 * stays clear. Its height is reported as the top inset.
 */
function Shell() {
    useShortcuts();
    const short = useMediaQuery('(max-height: 560px)');
    const topRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    useViewInsets(topRef, bottomRef);

    return (
        <div className="relative h-full w-full overflow-hidden bg-gray-950 font-sans text-gray-100 selection:bg-indigo-500/30">
            <CanvasBoard />

            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-3 sm:p-4">
                <EnvBanner missing={MISSING_ENV} />
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 lg:grid-cols-[auto_minmax(0,1fr)_auto]">
                    <div ref={topRef} className="flex min-w-0 flex-col items-start">
                        <MapCard compact={short} />
                    </div>
                    <div className="flex min-w-0 justify-self-end lg:col-start-3">
                        <ProfileButton />
                    </div>
                    {/* Short screens show one toast at a time */}
                    <Toasts
                        limit={short ? 1 : Infinity}
                        className="col-span-2 mx-auto w-full max-w-sm md:col-span-1 md:col-start-2 md:row-start-2 md:mx-0 md:w-80 md:items-end lg:col-start-2 lg:row-start-1 lg:mx-auto lg:w-full lg:max-w-sm lg:items-center"
                    />
                </div>
            </div>

            <div ref={bottomRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
                <Toolbar />
            </div>
        </div>
    );
}
