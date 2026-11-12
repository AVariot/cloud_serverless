import React, { useEffect, useRef, useState } from 'react';
import { CanvasRuntime } from '../runtime/CanvasRuntime';

export const CanvasBoard: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!canvasRef.current) return;
        let runtime: CanvasRuntime;
        try {
            runtime = new CanvasRuntime(canvasRef.current);
        } catch (e) {
            console.error(e);
            // eslint-disable-next-line react-hooks/set-state-in-effect -- surfacing a one-time init failure
            setError(e instanceof Error ? e.message : String(e));
            return;
        }
        return () => runtime.destroy();
    }, []);

    return (
        <>
            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full block select-none"
                style={{ touchAction: 'none' }}
                aria-label="Toile de pixels partagée"
            />
            {error && (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-gray-300">
                    Impossible de démarrer la toile : {error}. Un navigateur compatible WebGL2 est nécessaire.
                </div>
            )}
        </>
    );
};
