/**
 * Translates raw touch events over the mobile throw-height wedges into the
 * same hand-throw intents KeyboardInput produces for 'hold'/'tap' (see
 * Settings.js), plus a separate drag lifecycle for the mobile-only 'drag'
 * inputType. Game decides which one a given touch means (via `isDragMode`,
 * checked once at touchstart), then this class just tracks each touch's own
 * identifier through to its matching touchend/touchcancel - so two fingers
 * (e.g. one drag per hand) never get crossed with each other, the same way
 * KeyboardInput's keysHeld keeps independent keys straight.
 *
 * Unlike KeyboardInput, a touch needs to know *where* on screen it landed -
 * `hitTest(clientX, clientY)` is handed in by Game, wrapping
 * Renderer.hitTestMobileWedge with its own live this.mobileWedgeLayout (see
 * Game.updateMobileLayout) and ring count, rather than duplicating that
 * geometry here.
 */
export default class TouchInput {
    constructor(canvas, {
        hitTest,
        isDragMode,
        onThrowStart,
        onThrowRelease,
        onDragStart,
        onDragUpdate,
        onDragRelease,
        onDragCancel,
    }) {
        this.canvas = canvas;
        this.hitTest = hitTest;
        this.isDragMode = isDragMode;
        this.onThrowStart = onThrowStart;
        this.onThrowRelease = onThrowRelease;
        this.onDragStart = onDragStart;
        this.onDragUpdate = onDragUpdate;
        this.onDragRelease = onDragRelease;
        this.onDragCancel = onDragCancel;
        // Touch.identifier -> { hand, mode: 'holdtap', crossing } (crossing
        // fixed for the touch's whole life, same as a keyboard key) or
        // { hand, mode: 'drag' } (crossing instead tracked live - see
        // handleTouchMove/Game.handleDragUpdate).
        this.activeTouches = new Map();
        this.handleTouchStart = this.handleTouchStart.bind(this);
        this.handleTouchMove = this.handleTouchMove.bind(this);
        this.handleTouchEnd = this.handleTouchEnd.bind(this);
        this.handleTouchCancel = this.handleTouchCancel.bind(this);
    }

    attach() {
        // Not passive: a touch that lands on a wedge has to be able to
        // preventDefault so the page doesn't also scroll/pinch-zoom
        // underneath the gesture - belt-and-suspenders alongside
        // #juggle-canvas's touch-action: none (see mobile.less), which
        // handles the common case more cheaply on its own.
        this.canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
        this.canvas.addEventListener('touchend', this.handleTouchEnd, { passive: false });
        this.canvas.addEventListener('touchcancel', this.handleTouchCancel, { passive: false });
    }

    detach() {
        this.canvas.removeEventListener('touchstart', this.handleTouchStart);
        this.canvas.removeEventListener('touchmove', this.handleTouchMove);
        this.canvas.removeEventListener('touchend', this.handleTouchEnd);
        this.canvas.removeEventListener('touchcancel', this.handleTouchCancel);
        this.activeTouches.clear();
    }

    handleTouchStart(event) {
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const hit = this.hitTest(touch.clientX, touch.clientY);
            if (!hit) continue;
            event.preventDefault();

            if (this.isDragMode()) {
                // Drag only ever arms from the ball itself (see
                // Game.handleDragStart) - touching straight into the ring
                // band without having started there does nothing, same as
                // the ball not being "filled in" at all.
                if (hit.zone !== 'ball') continue;
                this.activeTouches.set(touch.identifier, { hand: hit.hand, mode: 'drag' });
                this.onDragStart(hit.hand);
            } else {
                // Hold/Tap only care which side was touched, not where
                // within the ring band - exactly like a keyboard press,
                // which likewise carries no notion of "how far charged" at
                // press time.
                if (hit.zone !== 'ring') continue;
                this.activeTouches.set(touch.identifier, { hand: hit.hand, mode: 'holdtap', crossing: hit.crossing });
                this.onThrowStart({ hand: hit.hand, crossing: hit.crossing });
            }
        }
    }

    handleTouchMove(event) {
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const info = this.activeTouches.get(touch.identifier);
            // Hold/Tap have no notion of "moving" mid-press (a physical key
            // has no position to move to) - only an active drag's ring/side
            // needs to keep tracking the finger.
            if (!info || info.mode !== 'drag') continue;
            event.preventDefault();

            const hit = this.hitTest(touch.clientX, touch.clientY);
            const overRing = hit && hit.hand === info.hand && hit.zone === 'ring';
            this.onDragUpdate(info.hand, overRing ? { crossing: hit.crossing, ring: hit.ring } : null);
        }
    }

    handleTouchEnd(event) {
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const info = this.activeTouches.get(touch.identifier);
            if (!info) continue;
            this.activeTouches.delete(touch.identifier);
            if (info.mode === 'drag') {
                this.onDragRelease(info.hand);
            } else {
                this.onThrowRelease({ hand: info.hand, crossing: info.crossing });
            }
        }
    }

    handleTouchCancel(event) {
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const info = this.activeTouches.get(touch.identifier);
            if (!info) continue;
            this.activeTouches.delete(touch.identifier);
            if (info.mode === 'drag') {
                // Unlike a normal release, an interrupted gesture (e.g. the
                // OS stealing the touch for its own edge-swipe) never locks
                // in whatever ring it happened to be over.
                this.onDragCancel(info.hand);
            } else {
                this.onThrowRelease({ hand: info.hand, crossing: info.crossing });
            }
        }
    }
}
