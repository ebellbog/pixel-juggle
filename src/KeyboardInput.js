// Default remappable bindings: which KeyboardEvent.key throws from which
// hand, self (same hand) or crossing (other hand). Kept as plain data - a
// future remap UI just needs to hand a differently-shaped copy of this same
// object to KeyboardInput's constructor.
export const DEFAULT_KEY_BINDINGS = {
    L: { self: 'z', cross: 'x' },
    R: { cross: ',', self: '.' },
};

/**
 * Translates raw keydown events into hand-throw intents - plain
 * { hand: 'L'|'R', crossing: boolean } objects - the one shape every input
 * scheme (keyboard now; touch and gamepad later) reduces down to, so Game
 * never needs to know which scheme produced a given throw.
 */
export default class KeyboardInput {
    constructor(onThrow, bindings = DEFAULT_KEY_BINDINGS) {
        this.onThrow = onThrow;
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

    handleKeyDown(event) {
        for (const hand of ['L', 'R']) {
            for (const crossing of [false, true]) {
                const key = this.bindings[hand][crossing ? 'cross' : 'self'];
                if (event.key === key) {
                    if (this.keysHeld.has(key)) return;
                    this.keysHeld.add(key);
                    this.onThrow({ hand, crossing });
                    return;
                }
            }
        }
    }

    handleKeyUp(event) {
        this.keysHeld.delete(event.key);
    }
}
