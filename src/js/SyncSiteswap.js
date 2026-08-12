import Siteswap from './Siteswap.js';

/**
 * Parses and validates synchronous siteswap notation - patterns where both
 * hands throw at once, written as beat-pairs like (4,4) or (4,2x)(2x,4), with
 * the first number in each pair thrown by the right hand and the second by
 * the left. A trailing '*' repeats the pattern with hands mirrored, e.g.
 * (4,2x)* = (4,2x)(2x,4) (the box).
 *
 * All heights must be even (S1/S2 in the standard rules): each beat-pair
 * represents two simultaneous throws, so only every other vanilla-beat has
 * anyone free to catch. An 'x' suffix marks a throw as crossing to the other
 * hand; without it, the throw returns to the same hand that threw it.
 *
 * Validity is defined via the "slide property": a synchronous sequence is
 * valid exactly when it can be converted into a valid vanilla sequence, so
 * this reuses Siteswap.validateSequence on that converted (slid) sequence
 * rather than re-deriving the math.
 */
export default class SyncSiteswap {
    constructor({ input, pairs, period, numBalls, isValid, error }) {
        this.input = input;
        // One entry per sync beat, each [{ value, crossing }, { value, crossing }]
        // for the right and left hand's simultaneous throw.
        this.pairs = pairs;
        this.period = period;
        this.numBalls = numBalls;
        this.isValid = isValid;
        this.error = error;
        // See Siteswap.isSync - lets callers (e.g. Game/ThrowHeight) special-
        // case sync's "every height is even, crossing is an independent 'x'"
        // convention instead of vanilla's "crossing iff odd".
        this.isSync = true;
    }

    static looksLikeSync(rawInput) {
        return String(rawInput ?? '').includes('(');
    }

    static parse(rawInput) {
        let input = String(rawInput ?? '').replace(/\s+/g, '').toLowerCase();

        if (input.length === 0) {
            return SyncSiteswap.invalid(input, 'Enter a siteswap to begin');
        }

        const mirror = input.endsWith('*');
        if (mirror) input = input.slice(0, -1);

        if (input.length === 0) {
            return SyncSiteswap.invalid(input, 'Enter a siteswap to begin');
        }

        if (!/^(\([0-9a-z]x?,[0-9a-z]x?\))+$/.test(input)) {
            return SyncSiteswap.invalid(input, "Expected beat-pairs like (4,2x), optionally ending in '*'");
        }

        const rawPairs = [];
        for (const match of input.matchAll(/\(([0-9a-z]x?),([0-9a-z]x?)\)/g)) {
            const right = SyncSiteswap.parseThrow(match[1]);
            const left = SyncSiteswap.parseThrow(match[2]);
            if (!right || !left) {
                return SyncSiteswap.invalid(input, `Invalid throw in '(${match[1]},${match[2]})'`);
            }
            rawPairs.push([right, left]);
        }

        // '*' repeats the pattern with hands swapped: (4,2x)* = (4,2x)(2x,4).
        const pairs = mirror ? rawPairs.concat(rawPairs.map(([r, l]) => [l, r])) : rawPairs;

        for (const [r, l] of pairs) {
            if (r.value % 2 !== 0 || l.value % 2 !== 0) {
                return SyncSiteswap.invalid(input, 'Synchronous throws must all be even');
            }
            if ((r.value === 0 && r.crossing) || (l.value === 0 && l.crossing)) {
                return SyncSiteswap.invalid(input, "'0x' is not allowed - there's nothing to cross");
            }
        }

        // Flatten to one throw per hand per beat-pair (right, then left),
        // matching the slide property's indexing (even index = right hand).
        const flat = [];
        for (const [r, l] of pairs) flat.push(r, l);

        const period = flat.length;
        const sum = flat.reduce((acc, t) => acc + t.value, 0);
        if (sum % period !== 0) {
            return SyncSiteswap.invalid(input, 'Average is not a whole number - not juggleable');
        }
        const numBalls = sum / period;

        // Slide property: adjust crossing throws by +-1 depending on beat
        // parity to get an equivalent vanilla sequence, then reuse the
        // permutation theorem to check it's actually juggleable.
        const slid = flat.map((t, i) => {
            if (!t.crossing) return t.value;
            return i % 2 === 0 ? t.value + 1 : t.value - 1;
        });
        const { isValid, error } = Siteswap.validateSequence(slid);
        if (!isValid) {
            return SyncSiteswap.invalid(input, error);
        }

        return new SyncSiteswap({
            input,
            pairs,
            period: pairs.length * 2,
            numBalls,
            isValid: true,
            error: null,
        });
    }

    static parseThrow(token) {
        const crossing = token.endsWith('x');
        const value = Siteswap.charToValue(crossing ? token.slice(0, -1) : token);
        return value === null ? null : { value, crossing };
    }

    static invalid(input, error) {
        return new SyncSiteswap({ input, pairs: [], period: 0, numBalls: 0, isValid: false, error });
    }

    /**
     * Same hand-explicit schedule shape as Siteswap.toSchedule(). Each
     * beat-pair occupies one beat with both hands active, immediately
     * followed by a forced empty beat - per the standard rules, a sync
     * pattern only ever has throws on every other beat.
     */
    toSchedule() {
        const slots = [];
        for (const [r, l] of this.pairs) {
            const R = r.value > 0 ? { height: r.value, crossing: r.crossing } : null;
            const L = l.value > 0 ? { height: l.value, crossing: l.crossing } : null;
            slots.push({ R, L });
            slots.push({ R: null, L: null });
        }
        return { period: slots.length, numBalls: this.numBalls, slots };
    }
}
