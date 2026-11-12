const DRAG_THRESHOLD = 5; // CSS pixels before a press becomes a drag
const WHEEL_SENSITIVITY = 0.0025;
// Touch + brush: wait this long (or this much movement) before painting, so the
// first finger of a pinch never leaves a stray stamp
const TOUCH_STROKE_DELAY_MS = 120;
const TOUCH_STROKE_SLOP = 4;

export type InputMode = 'select' | 'brush';

// All coordinates passed to handlers are CSS pixels relative to the canvas.
export interface InputHandlers {
    onInteractionStart(): void;
    onPan(dx: number, dy: number): void;
    onZoom(factor: number, x: number, y: number): void;
    /** Click/tap without drag (select mode) */
    onTap(x: number, y: number): void;
    onHover(x: number, y: number): void;
    /** Pointer left the canvas (hide hover feedback) */
    onLeave(): void;
    /** Brush mode: whether a press may paint now (false: it pans instead) */
    canStroke(): boolean;
    /** Brush mode: a paint stroke starts / continues / ends */
    onStrokeStart(x: number, y: number): void;
    onStrokeMove(x: number, y: number): void;
    onStrokeEnd(): void;
    /** Panning state changed (cursor feedback) */
    onPanningChange(panning: boolean): void;
}

type Point = { x: number; y: number };
type Gesture = 'none' | 'press' | 'pan' | 'stroke' | 'pinch' | 'touchwait';

const isTypingTarget = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// Translates mouse/pen pointer events and touch gestures into pan/zoom/tap/stroke.
// Mouse and pen use pointer events; touch uses touch events (for pinch).
//
// Select mode: left drag pans, click selects.
// Brush mode: left drag paints; right/middle drag or Space + drag pans;
// one finger paints, two fingers pan and zoom.
export class InputController {
    private canvas: HTMLCanvasElement;
    private handlers: InputHandlers;
    private mode: InputMode = 'select';

    private activePointerId: number | null = null;
    private gesture: Gesture = 'none';
    private pressPansOnly = false; // the current press can only pan (right/middle button, Space)
    private dragStart: Point = { x: 0, y: 0 };
    private last: Point = { x: 0, y: 0 };
    private spaceDown = false;

    private lastTouchDist = 0;
    private lastTouchMid: Point = { x: 0, y: 0 };
    private touchTimer = 0;
    /** Last mouse/pen position over the canvas (CSS px), null when it left or touch is used */
    private mouse: Point | null = null;

    constructor(canvas: HTMLCanvasElement, handlers: InputHandlers) {
        this.canvas = canvas;
        this.handlers = handlers;
        this.listen(true);
    }

    public dispose() {
        this.endGesture();
        this.listen(false);
    }

    public setMode(mode: InputMode) {
        if (mode === this.mode) return;
        // A mode switch mid-gesture (keyboard shortcut) ends a stroke or a pending press;
        // navigation (pan, pinch) carries on
        if (this.gesture === 'stroke' || this.gesture === 'press' || this.gesture === 'touchwait') this.endGesture();
        this.mode = mode;
    }

    /** Where the mouse is, so the engine can refresh the hovered pixel when the camera moves under it */
    public get mousePosition(): Point | null {
        return this.mouse;
    }

    public get isPanning() {
        return this.gesture === 'pan' || this.gesture === 'pinch';
    }

    private listen(add: boolean) {
        const c = this.canvas;
        const on = add ? c.addEventListener.bind(c) : c.removeEventListener.bind(c);
        on('pointerdown', this.onPointerDown);
        on('pointermove', this.onPointerMove);
        on('pointerup', this.onPointerUp);
        on('pointercancel', this.onPointerCancel);
        on('pointerleave', this.onPointerLeave);
        // Capture can be released without a pointerup (alt-tab, dialogs)
        on('lostpointercapture', this.onPointerCancel);
        on('wheel', this.onWheel, { passive: false });
        on('contextmenu', this.onContextMenu);
        on('touchstart', this.onTouchStart, { passive: false });
        on('touchmove', this.onTouchMove, { passive: false });
        on('touchend', this.onTouchEnd);
        on('touchcancel', this.onTouchEnd);
        const won = add ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
        won('keydown', this.onKeyDown);
        won('keyup', this.onKeyUp);
        won('blur', this.onBlur);
    }

    private toLocal(clientX: number, clientY: number, rect: DOMRect = this.canvas.getBoundingClientRect()): Point {
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    private setGesture(g: Gesture) {
        const wasPanning = this.isPanning;
        this.gesture = g;
        if (wasPanning !== this.isPanning) this.handlers.onPanningChange(this.isPanning);
    }

    private endGesture() {
        this.clearTouchTimer();
        if (this.gesture === 'stroke') this.handlers.onStrokeEnd();
        this.setGesture('none');
        this.activePointerId = null;
    }

    // Starts a press: it becomes a pan, a stroke or a tap depending on mode and movement
    private beginPress(clientX: number, clientY: number, pansOnly: boolean) {
        this.handlers.onInteractionStart();
        this.pressPansOnly = pansOnly;
        this.dragStart = { x: clientX, y: clientY };
        this.last = { x: clientX, y: clientY };
        if (this.mode === 'brush' && !pansOnly && this.handlers.canStroke()) {
            this.setGesture('stroke');
            const p = this.toLocal(clientX, clientY);
            this.handlers.onStrokeStart(p.x, p.y);
        } else {
            this.setGesture('press');
        }
    }

    private movePress(clientX: number, clientY: number, rect?: DOMRect) {
        if (this.gesture === 'stroke') {
            const p = this.toLocal(clientX, clientY, rect);
            this.handlers.onStrokeMove(p.x, p.y);
            return;
        }
        if (this.gesture === 'press' && Math.hypot(clientX - this.dragStart.x, clientY - this.dragStart.y) > DRAG_THRESHOLD) {
            this.setGesture('pan');
        }
        if (this.gesture === 'pan') {
            this.handlers.onPan(clientX - this.last.x, clientY - this.last.y);
            this.last = { x: clientX, y: clientY };
        }
    }

    /** Returns true when the release was a tap */
    private releasePress(clientX: number, clientY: number): boolean {
        const tapped = this.gesture === 'press' && !this.pressPansOnly && this.mode === 'select' && this.tap(clientX, clientY);
        this.endGesture();
        return tapped;
    }

    // Releasing outside the canvas (after a tiny move) is not a tap
    private tap(clientX: number, clientY: number): boolean {
        const p = this.toLocal(clientX, clientY);
        if (p.x < 0 || p.y < 0 || p.x >= this.canvas.clientWidth || p.y >= this.canvas.clientHeight) return false;
        this.handlers.onTap(p.x, p.y);
        return true;
    }

    // --- Mouse & pen ---

    private onPointerDown = (e: PointerEvent) => {
        if (e.pointerType === 'touch' || this.activePointerId !== null) return;
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        if (e.button === 1) e.preventDefault(); // no autoscroll
        // Capture keeps move/up events coming when the pointer leaves the canvas
        this.canvas.setPointerCapture(e.pointerId);
        this.activePointerId = e.pointerId;
        this.beginPress(e.clientX, e.clientY, e.button !== 0 || this.spaceDown);
    };

    private onPointerMove = (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        const rect = this.canvas.getBoundingClientRect(); // once per event, not per coalesced sample
        if (e.pointerId === this.activePointerId) {
            // Coalesced events keep fast strokes dense
            const events = this.gesture === 'stroke' && e.getCoalescedEvents ? e.getCoalescedEvents() : [];
            if (events.length > 1) for (const ce of events) this.movePress(ce.clientX, ce.clientY, rect);
            else this.movePress(e.clientX, e.clientY, rect);
        }
        const p = this.toLocal(e.clientX, e.clientY, rect);
        this.mouse = p;
        this.handlers.onHover(p.x, p.y);
    };

    private onPointerUp = (e: PointerEvent) => {
        if (e.pointerId !== this.activePointerId) return;
        this.releasePress(e.clientX, e.clientY);
    };

    private onPointerCancel = (e: PointerEvent) => {
        if (e.pointerId !== this.activePointerId) return;
        this.endGesture();
    };

    private onPointerLeave = (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        this.mouse = null;
        if (this.activePointerId === null) this.handlers.onLeave();
    };

    private onContextMenu = (e: Event) => e.preventDefault(); // right-drag pans

    private onWheel = (e: WheelEvent) => {
        e.preventDefault();
        if (e.deltaY === 0) return; // horizontal scroll: no zoom
        // Normalize line/page deltas to pixels, then zoom proportionally (smooth on trackpads)
        const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1);
        const factor = Math.exp(-Math.max(-100, Math.min(delta, 100)) * WHEEL_SENSITIVITY);
        const p = this.toLocal(e.clientX, e.clientY);
        this.handlers.onInteractionStart();
        this.handlers.onZoom(factor, p.x, p.y);
    };

    // --- Keyboard: Space held turns the brush drag into a pan ---

    private onKeyDown = (e: KeyboardEvent) => {
        if (e.code !== 'Space' || isTypingTarget(e.target)) return;
        // Space would otherwise scroll or press the focused button
        if (this.mode === 'brush') e.preventDefault();
        this.spaceDown = true;
    };

    private onKeyUp = (e: KeyboardEvent) => {
        if (e.code === 'Space') this.spaceDown = false;
    };

    private onBlur = () => {
        this.spaceDown = false;
    };

    // --- Touch (targetTouches: ignore fingers resting elsewhere on the page) ---

    private static touchDist(t: TouchList) {
        return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    }

    private static touchMid(t: TouchList): Point {
        return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
    }

    private clearTouchTimer() {
        if (this.touchTimer) clearTimeout(this.touchTimer);
        this.touchTimer = 0;
    }

    // touchwait -> stroke, starting where the finger went down
    private startTouchStroke() {
        this.clearTouchTimer();
        if (this.gesture !== 'touchwait') return;
        if (!this.handlers.canStroke()) {
            // Too far out to paint: the finger pans
            this.pressPansOnly = true;
            this.setGesture('press');
            return;
        }
        this.setGesture('stroke');
        const p = this.toLocal(this.dragStart.x, this.dragStart.y);
        this.handlers.onStrokeStart(p.x, p.y);
    }

    private beginPinch(t: TouchList) {
        this.clearTouchTimer();
        // A second finger ends any stroke: two fingers always navigate
        if (this.gesture === 'stroke') this.handlers.onStrokeEnd();
        this.setGesture('pinch');
        this.lastTouchDist = InputController.touchDist(t);
        this.lastTouchMid = InputController.touchMid(t);
    }

    private onTouchStart = (e: TouchEvent) => {
        e.preventDefault();
        this.mouse = null;
        if (e.targetTouches.length === 1) {
            const t = e.targetTouches[0];
            if (this.mode === 'brush') {
                this.handlers.onInteractionStart();
                this.pressPansOnly = false;
                this.dragStart = { x: t.clientX, y: t.clientY };
                this.last = { x: t.clientX, y: t.clientY };
                this.setGesture('touchwait');
                this.clearTouchTimer();
                this.touchTimer = window.setTimeout(() => this.startTouchStroke(), TOUCH_STROKE_DELAY_MS);
            } else {
                this.beginPress(t.clientX, t.clientY, false);
            }
            const p = this.toLocal(t.clientX, t.clientY);
            this.handlers.onHover(p.x, p.y);
        } else if (e.targetTouches.length >= 2) {
            this.handlers.onInteractionStart();
            this.beginPinch(e.targetTouches);
        }
    };

    private onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        if (e.targetTouches.length === 1) {
            const t = e.targetTouches[0];
            if (this.gesture === 'touchwait') {
                if (Math.hypot(t.clientX - this.dragStart.x, t.clientY - this.dragStart.y) <= TOUCH_STROKE_SLOP) return;
                this.startTouchStroke();
            }
            this.movePress(t.clientX, t.clientY);
            if (this.gesture === 'stroke') {
                const p = this.toLocal(t.clientX, t.clientY);
                this.handlers.onHover(p.x, p.y);
            }
        } else if (e.targetTouches.length >= 2) {
            if (this.gesture !== 'pinch') this.beginPinch(e.targetTouches);
            const dist = InputController.touchDist(e.targetTouches);
            const mid = InputController.touchMid(e.targetTouches);

            this.handlers.onPan(mid.x - this.lastTouchMid.x, mid.y - this.lastTouchMid.y);
            if (this.lastTouchDist > 0) {
                const p = this.toLocal(mid.x, mid.y);
                this.handlers.onZoom(dist / this.lastTouchDist, p.x, p.y);
            }
            this.lastTouchDist = dist;
            this.lastTouchMid = mid;
        }
    };

    private onTouchEnd = (e: TouchEvent) => {
        if (e.targetTouches.length === 0) {
            let tapped = false;
            if (this.gesture === 'touchwait' && e.type === 'touchend') {
                // Quick tap with the brush: one stamp
                this.startTouchStroke();
                this.endGesture();
            } else if (e.type === 'touchend' && e.changedTouches.length === 1 && this.gesture !== 'pinch') {
                const t = e.changedTouches[0];
                tapped = this.releasePress(t.clientX, t.clientY);
            } else {
                this.endGesture();
            }
            this.lastTouchDist = 0;
            // A tap keeps the tapped pixel as the hovered one (touch has no hover)
            if (!tapped) this.handlers.onLeave();
        } else if (e.targetTouches.length === 1) {
            // Pinch -> single finger: keep panning from the remaining finger, never paint
            const t = e.targetTouches[0];
            this.pressPansOnly = true;
            this.setGesture('pan');
            this.last = { x: t.clientX, y: t.clientY };
            this.lastTouchDist = 0;
        } else {
            this.beginPinch(e.targetTouches);
        }
    };
}
