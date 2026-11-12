import type { ButtonHTMLAttributes, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { iconButton } from './styles';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
    /** Accessible name, also the tooltip */
    label: string;
    icon: LucideIcon;
    /** Keyboard shortcut appended to the tooltip: "Zoomer (+)" */
    shortcut?: string;
    iconSize?: number;
    ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, icon: Icon, shortcut, iconSize = 16, className = '', title, ...rest }: IconButtonProps) {
    return (
        <button
            type="button"
            aria-label={label}
            title={title ?? (shortcut ? `${label} (${shortcut})` : label)}
            className={`${iconButton} ${className}`}
            {...rest}
        >
            <Icon size={iconSize} aria-hidden="true" />
        </button>
    );
}
