import { useUIStore } from '../store';
import { BrushControls } from './toolbar/BrushControls';
import { DrawActivity } from './toolbar/DrawActivity';
import { Palette } from './toolbar/Palette';
import { SelectActions } from './toolbar/SelectActions';
import { ToolToggle } from './toolbar/ToolToggle';
import { panel } from './ui/styles';

/**
 * Bottom toolbar: draw activity strip, a fixed-height context row (brush settings,
 * hint or placing actions) and the tool toggle + palette. Never reads `hover`, so
 * mouse moves do not re-render it.
 */
export function Toolbar() {
    const tool = useUIStore((s) => s.tool);

    return (
        <section
            aria-label="Outils de dessin"
            className={`${panel} pointer-events-auto w-full max-w-full rounded-2xl p-2 sm:w-auto sm:p-2.5`}
        >
            <DrawActivity />
            <div className="flex min-h-9 items-center justify-center px-1 pb-2">
                {tool === 'brush' ? <BrushControls /> : <SelectActions />}
            </div>
            <div className="flex items-center justify-center gap-2 sm:gap-3">
                <ToolToggle />
                <span aria-hidden="true" className="hidden h-8 w-px shrink-0 bg-gray-700 sm:block" />
                <Palette />
            </div>
        </section>
    );
}
