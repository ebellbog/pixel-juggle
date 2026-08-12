// Default remappable bindings: which KeyboardEvent.key throws from which
// hand, self (same hand) or crossing (other hand). Kept as plain data - a
// future remap UI just needs to hand a differently-shaped copy of this same
// object to KeyboardInput's constructor.
export const DEFAULT_KEY_BINDINGS = {
    L: { self: 'z', cross: 'x' },
    R: { cross: ',', self: '.' },
};

/** Maps a binding key to the glyph shown in Keycaps font (see Renderer, controls modal). */
export function formatKeycapLabel(key) {
    if (key === ',') return '<';
    if (key === '.') return '>';
    return key.toUpperCase();
}

/** Shape passed to the controls modal body template (see controls-body.handlebars). */
export function buildControlsModalData(bindings = DEFAULT_KEY_BINDINGS, { inputType = 'hold' } = {}) {
    const heightControlPhrase = inputType === 'tap'
        ? 'tap the key repeatedly'
        : 'hold the key down longer';

    return {
        leftSelf: formatKeycapLabel(bindings.L.self),
        leftCross: formatKeycapLabel(bindings.L.cross),
        rightCross: formatKeycapLabel(bindings.R.cross),
        rightSelf: formatKeycapLabel(bindings.R.self),
        heightControlPhrase,
    };
}

/**
 * Translates raw keydown/keyup events into hand-throw intents - plain
 * { hand: 'L'|'R', crossing: boolean } objects - the one shape every input
 * scheme (keyboard now; touch and gamepad later) reduces down to, so Game
 * never needs to know which scheme produced a given throw. Reports both the
 * press (onThrowStart) and the release (onThrowRelease) since throw height
 * is now determined by how long the button was held (see Game).
 */
export default class KeyboardInput {
    constructor({ onThrowStart, onThrowRelease }, bindings = DEFAULT_KEY_BINDINGS) {
        this.onThrowStart = onThrowStart;
        this.onThrowRelease = onThrowRelease;
        this.bindings = bindings;
        this.keysHeld = new Set();
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleKeyUp = this.handleKeyUp.bind(this);
    }

    attach() {
        window.addEventListener('keydown', this.handleKeyDown);
        window.addEventListener('keyup', this.handleKeyUp);
    }

    detach() {
        window.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('keyup', this.handleKeyUp);
        this.keysHeld.clear();
    }

    /** Finds which binding, if any, `key` matches. */
    lookupBinding(key) {
        for (const hand of ['L', 'R']) {
            for (const crossing of [false, true]) {
                if (key === this.bindings[hand][crossing ? 'cross' : 'self']) {
                    return { hand, crossing };
                }
            }
        }
        return null;
    }

    handleKeyDown(event) {
        const intent = this.lookupBinding(event.key);
        if (!intent) return;
        // Ignore OS key-repeat while already held - a throw should only
        // start charging once per physical press, not once per repeat event.
        if (this.keysHeld.has(event.key)) return;
        this.keysHeld.add(event.key);
        this.onThrowStart(intent);
    }

    handleKeyUp(event) {
        if (!this.keysHeld.delete(event.key)) return;
        const intent = this.lookupBinding(event.key);
        if (intent) this.onThrowRelease(intent);
    }
}
