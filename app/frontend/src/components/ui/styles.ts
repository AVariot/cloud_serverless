// Shared class names for the floating panels. Dark glass over the canvas: the
// background stays >= 90 % opaque so gray-300/400 text keeps a 4.5:1 contrast
// even above white pixels.

export const panel = 'rounded-xl border border-gray-700/80 bg-gray-900/90 shadow-xl shadow-black/30 backdrop-blur-md';

export const iconButton =
    'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-300 transition-colors ' +
    'hover:bg-gray-700/70 hover:text-white active:bg-gray-700 disabled:pointer-events-none disabled:opacity-40';

export const primaryButton =
    'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white ' +
    'shadow-sm transition-colors hover:bg-indigo-500 active:bg-indigo-700';

export const secondaryButton =
    'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-600 bg-gray-800 px-3 text-sm font-medium ' +
    'text-gray-200 transition-colors hover:border-gray-500 hover:bg-gray-700 hover:text-white';

export const smallButton =
    'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/80 px-2.5 text-xs ' +
    'font-medium text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-700 hover:text-white';

/** Segmented control container and its items (aria-pressed buttons) */
export const segmented = 'inline-flex shrink-0 gap-0.5 rounded-lg border border-gray-700 bg-gray-950/70 p-0.5';

export const segment = (active: boolean) =>
    'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors ' +
    (active ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-300 hover:bg-gray-800 hover:text-white');

/** Keyboard hint shown next to button labels on wide screens */
export const kbd =
    'hidden rounded border border-white/20 px-1 font-sans text-[10px] leading-4 font-medium opacity-80 lg:inline-block';

/** Color swatch outline: keeps black and white swatches visible on any background */
export const swatchEdge = 'inset-ring-1 inset-ring-black/25';

/** Map card rows: a 32 px icon column, then the content, then the actions on the right */
export const cardRow = 'flex h-10 items-center gap-1.5 px-1';
export const cardRowIcon = 'flex size-8 shrink-0 items-center justify-center text-gray-500';
/** Content under a row header, aligned with the content column */
export const cardIndent = 'pl-[2.625rem] pr-3';
/** Small uppercase axis / field label ("X", "Y") */
export const fieldLabel = 'text-[11px] font-medium text-gray-500';
