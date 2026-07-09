/**
 * Parses and validates vanilla (asynchronous) siteswap notation, and lowers a
 * valid pattern into a notation-neutral throw schedule that the simulator can
 * consume. SyncSiteswap produces the same schedule shape (see its header for
 * why hand assignment is explicit rather than inferred from beat parity), and
 * reuses validateSequence below, since a valid synchronous pattern is defined
 * as one that reduces to a valid vanilla sequence (the "slide property").
 */
export default class Siteswap {
    constructor({ input, values, period, numBalls, isValid, error }) {
        this.input = input;
        this.values = values;
        this.period = period;
        this.numBalls = numBalls;
        this.isValid = isValid;
        this.error = error;
    }

    static parse(rawInput) {
        const input = String(rawInput ?? '').replace(/\s+/g, '').toLowerCase();

        if (input.length === 0) {
            return Siteswap.invalid(input, 'Enter a siteswap to begin');
        }

        const values = [];
        for (const ch of input) {
            const value = Siteswap.charToValue(ch);
            if (value === null) {
                return Siteswap.invalid(input, `Invalid character '${ch}'`);
            }
            values.push(value);
        }

        const { isValid, numBalls, error } = Siteswap.validateSequence(values);
        if (!isValid) {
            return Siteswap.invalid(input, error);
        }

        return new Siteswap({
            input,
            values,
            period: values.length,
            numBalls,
            isValid: true,
            error: null,
        });
    }

    /**
     * The average and permutation theorems, on a plain array of throw
     * heights (one per beat, one hand at a time). Necessary and sufficient
     * for a vanilla sequence; also the core of sync validity via the slide
     * property, so SyncSiteswap calls this on its slid vanilla-equivalent
     * sequence rather than duplicating the math.
     */
    static validateSequence(values) {
        const period = values.length;
        const sum = values.reduce((acc, v) => acc + v, 0);

        // Average theorem: a necessary condition, checked first for a
        // friendlier message than a raw collision error.
        if (sum % period !== 0) {
            return { isValid: false, numBalls: 0, error: 'Average is not a whole number - not juggleable' };
        }
        const numBalls = sum / period;

        // Permutation theorem: necessary AND sufficient. The landing beats
        // (i + values[i]) mod period must all be distinct.
        const landings = new Array(period).fill(0);
        for (let i = 0; i < period; i++) {
            landings[(i + values[i]) % period] += 1;
        }
        if (landings.some((count) => count !== 1)) {
            return { isValid: false, numBalls: 0, error: 'Throws collide - not juggleable' };
        }

        return { isValid: true, numBalls, error: null };
    }

    static invalid(input, error) {
        return new Siteswap({
            input,
            values: [],
            period: 0,
            numBalls: 0,
            isValid: false,
            error,
        });
    }

    /** '0'-'9' -> 0-9, 'a'-'z' -> 10-35. Returns null for anything else. */
    static charToValue(ch) {
        const value = parseInt(ch, 36);
        return Number.isNaN(value) ? null : value;
    }

    /**
     * Notation-neutral schedule consumed by the simulator. `slots` is indexed
     * by beat; each entry names which hand(s) throw that beat (null if idle)
     * rather than leaving hand assignment to beat parity, so the same shape
     * covers synchronous beats where both hands act at once. In vanilla,
     * exactly one hand is ever active per beat, strictly alternating R, L,
     * R, L... by *absolute* beat number, starting with the right hand.
     *
     * That alternation is what makes the schedule's true period 2x the
     * notation's period whenever the notation's period is odd: the throw
     * heights repeat every `period` beats, but which hand is "up" only
     * repeats every 2 beats, and those two cycles don't realign until their
     * lcm - period beats if period is even, 2*period if it's odd. Skipping
     * this doubling for an odd-period pattern (e.g. plain "3") would silently
     * feed every throw to the same hand forever instead of alternating.
     */
    toSchedule() {
        const schedulePeriod = this.period % 2 === 0 ? this.period : this.period * 2;
        const slots = [];
        for (let beat = 0; beat < schedulePeriod; beat++) {
            const height = this.values[beat % this.period];
            if (height <= 0) {
                slots.push({ R: null, L: null });
                continue;
            }
            const entry = { height, crossing: height % 2 === 1 };
            slots.push(beat % 2 === 0 ? { R: entry, L: null } : { R: null, L: entry });
        }
        return { period: schedulePeriod, numBalls: this.numBalls, slots };
    }
}
