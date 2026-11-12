import { Brush, MousePointer2 } from 'lucide-react';
import { useUIStore } from '../../store';
import type { Tool } from '../../types';
import { segment, segmented } from '../ui/styles';

const TOOLS: readonly { id: Tool; label: string; shortcut: string; icon: typeof Brush }[] = [
    { id: 'select', label: 'Sélection', shortcut: 'V', icon: MousePointer2 },
    { id: 'brush', label: 'Pinceau', shortcut: 'B', icon: Brush },
];

/** Select / brush segmented control: stacked icons on phones, labelled row from sm */
export function ToolToggle() {
    const tool = useUIStore((s) => s.tool);
    const setTool = useUIStore((s) => s.setTool);

    return (
        <div role="group" aria-label="Outil" className={`${segmented} flex-col sm:flex-row`}>
            {TOOLS.map(({ id, label, shortcut, icon: Icon }) => (
                <button
                    key={id}
                    type="button"
                    aria-pressed={tool === id}
                    title={`${label} (${shortcut})`}
                    onClick={() => setTool(id)}
                    className={`${segment(tool === id)} h-7 w-9 sm:h-8 sm:w-auto sm:px-3`}
                >
                    <Icon size={16} aria-hidden="true" />
                    <span className="max-sm:sr-only">{label}</span>
                </button>
            ))}
        </div>
    );
}
