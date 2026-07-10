// How long (as a fraction of one beat) the player has to climb the height
// ladder - ring progression and the cancel threshold both use this window,
// not the full beat (see computeLitRings and chargePastCancelThreshold).
export const CHARGE_WINDOW_FRACTION = 0.6;

// How long (as a fraction of one beat) the wedge flashes red right after
// the hold crosses the charge window - feedback that releasing now cancels.
export const CANCEL_FLASH_FRACTION = 0.20;

/**
 * The two height "ladders" a player can pick from with a held throw, given
 * the tallest throw this siteswap ever calls for. Crossing throws only ever
 * land on odd heights (1, 3, 5, ...) and self throws only on even ones
 * (2, 4, ...) under the usual alternating-hands convention. Each ladder
 * includes every height of its parity up to maxHeight; if that leaves one
 * side with fewer rings than the other (e.g. max height 3 → cross has 1 &
 * 3 but self only has 2), the shorter side is extended with the next
 * heights in its parity so both wedges always show the same ring count.
 */
export function getAvailableHeights(maxHeight) {
    const crossHeights = [];
    for (let h = 1; h <= maxHeight; h += 2) crossHeights.push(h);
    const selfHeights = [];
    for (let h = 2; h <= maxHeight; h += 2) selfHeights.push(h);

    const ringCount = Math.max(crossHeights.length, selfHeights.length);
    while (crossHeights.length < ringCount) {
        crossHeights.push(crossHeights[crossHeights.length - 1] + 2);
    }
    while (selfHeights.length < ringCount) {
        selfHeights.push(selfHeights.length === 0 ? 2 : selfHeights[selfHeights.length - 1] + 2);
    }

    return { crossHeights, selfHeights };
}

/**
 * How many rings (1..ringTotal) should be lit after `elapsedSeconds` of hold,
 * given the current `beatDurationSeconds`. The charge window (see
 * CHARGE_WINDOW_FRACTION) is split into equal windows - e.g. three rings at
 * 33% / 66% / 100% of that window - and rings accumulate: first window lights
 * ring 1, second lights 1+2, third lights 1+2+3. Returns 0 if there are no
 * rings.
 */
export function computeLitRings(ringTotal, elapsedSeconds, beatDurationSeconds) {
    if (ringTotal <= 0) return 0;
    if (ringTotal === 1) return 1;
    const chargeWindowSeconds = beatDurationSeconds * CHARGE_WINDOW_FRACTION;
    const elapsedFraction = chargeWindowSeconds > 0 ? elapsedSeconds / chargeWindowSeconds : 1;
    if (elapsedFraction >= 1) return ringTotal;
    return Math.min(ringTotal, Math.floor(elapsedFraction * ringTotal) + 1);
}

/** True once the button has been held past the charge window. */
export function chargePastCancelThreshold(elapsedSeconds, beatDurationSeconds) {
    if (beatDurationSeconds <= 0) return true;
    return elapsedSeconds / beatDurationSeconds >= CHARGE_WINDOW_FRACTION;
}

/** True during the brief red-flash window just after crossing the charge window. */
export function chargeInCancelFlash(elapsedSeconds, beatDurationSeconds) {
    if (beatDurationSeconds <= 0) return false;
    const fraction = elapsedSeconds / beatDurationSeconds;
    return fraction >= CHARGE_WINDOW_FRACTION && fraction < CHARGE_WINDOW_FRACTION + CANCEL_FLASH_FRACTION;
}

/** True once the hold is past the red-flash window - wedge hidden, release still cancels. */
export function chargeWedgeHidden(elapsedSeconds, beatDurationSeconds) {
    if (beatDurationSeconds <= 0) return true;
    return elapsedSeconds / beatDurationSeconds >= CHARGE_WINDOW_FRACTION + CANCEL_FLASH_FRACTION;
}
