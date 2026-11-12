import React, { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '../../auth/store';
import { LoginScreen } from './LoginScreen';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const status = useAuthStore((s) => s.status);
    const initialize = useAuthStore((s) => s.initialize);

    useEffect(() => {
        initialize();
    }, [initialize]);

    if (status === 'loading') {
        return (
            <div role="status" className="flex h-full w-full items-center justify-center bg-gray-950 text-gray-400">
                <Loader2 size={24} className="animate-spin" aria-hidden="true" />
                <span className="sr-only">Chargement…</span>
            </div>
        );
    }

    if (status === 'unauthenticated') return <LoginScreen />;

    return <>{children}</>;
};
