import { memo } from 'react';
import { Check } from 'lucide-react';
import { useUIStore } from '../../store';
import { PALETTE, type PaletteColor } from '../../palette';
import { isLightRgb } from '../../lib/format';
import { swatchEdge } from '../ui/styles';

/** Picks a color; with the select tool and a selected pixel, it also enters placing mode */
function pickColor(id: number) {
    const s = useUIStore.getState();
    s.setColor(id);
    if (s.tool === 'select' && s.selected) s.startPlacing();
}

const Swatch = memo(function Swatch({ color, selected }: { color: PaletteColor; selected: boolean }) {
    return (
        <button
            type="button"
            aria-label={color.name}
            aria-pressed={selected}
            title={color.name}
            onClick={(e) => {
                pickColor(color.id);
                // After a mouse click, don't keep focus on the swatch: Enter must reach the
                // "Valider (Entrée)" shortcut instead of clicking the swatch again
                if (e.detail > 0) e.currentTarget.blur();
            }}
            className={
                `relative flex size-7 items-center justify-center rounded-full transition-transform sm:size-8 ${swatchEdge} ` +
                (selected
                    ? 'z-10 ring-2 ring-white ring-offset-2 ring-offset-gray-900'
                    : 'hover:scale-110 active:scale-95')
            }
            style={{ backgroundColor: color.hex }}
        >
            {selected && (
                <Check
                    size={16}
                    strokeWidth={3}
                    aria-hidden="true"
                    className={isLightRgb(color.rgb) ? 'text-gray-900' : 'text-white'}
                />
            )}
        </button>
    );
});

/** Every palette color: 8 per row up to lg, one row from lg */
export function Palette() {
    const colorId = useUIStore((s) => s.colorId);

    return (
        <div role="group" aria-label="Couleurs" className="grid grid-cols-8 gap-1.5 sm:gap-2 lg:grid-flow-col lg:grid-cols-none">
            {PALETTE.map((c) => (
                <Swatch key={c.id} color={c} selected={c.id === colorId} />
            ))}
        </div>
    );
}
