/**
 * Parses and validates vanilla (asynchronous) siteswap notation, and lowers a
 * valid pattern into a notation-neutral throw schedule that the simulator can
 * consume. A future SyncSiteswap parser can produce the same schedule shape.
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

        const period = values.length;
        const sum = values.reduce((acc, v) => acc + v, 0);

        // Average theorem: a necessary condition, checked first for a friendlier
        // message than a raw collision error.
        if (sum % period !== 0) {
            return Siteswap.invalid(input, 'Average is not a whole number - not juggleable');
        }
        const numBalls = sum / period;

        // Permutation theorem: necessary AND sufficient. The landing beats
        // (i + values[i]) mod period must all be distinct.
        const landings = new Array(period).fill(0);
        for (let i = 0; i < period; i++) {
            landings[(i + values[i]) % period] += 1;
        }
        if (landings.some((count) => count !== 1)) {
            return Siteswap.invalid(input, 'Throws collide - not juggleable');
        }

        return new Siteswap({
            input,
            values,
            period,
            numBalls,
            isValid: true,
            error: null,
        });
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
     * Notation-neutral schedule consumed by the simulator. `slots` is indexed by
     * beat within one period; each entry is either null (empty beat) or a throw
     * descriptor. `crossing` says whether the ball changes hands (derivable from
     * parity for async, but stored so synchronous patterns can set it explicitly).
     */
    toSchedule() {
        return {
            sync: false,
            period: this.period,
            numBalls: this.numBalls,
            slots: this.values.map((height) =>
                height > 0 ? { height, crossing: height % 2 === 1 } : null
            ),
        };
    }
}
