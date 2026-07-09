// How far apart, in ball-radius multiples, consecutive queued balls under one
// hand sit from each other. Shared by JugglingSimulator (the fixed, schedule-
// derived queue of not-yet-spawned balls shown at the start of "Show me") and
// Game (the live, player-driven queue in "Let me try!") so both lay their
// queues out identically, even though each owns very different queue *state*.
export const QUEUE_SPACING_RADII = 2.4;

function smoothstep(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}

/**
 * Slot index for a queued ball during an inward shift after the innermost
 * ball leaves. Before the shift starts, the ball sits one slot outward
 * (arrayIndex + 1); after it finishes, at arrayIndex; in between, eased
 * smoothly between the two. `shiftStart`/`shiftUntil` are this one hand's
 * own window (callers keep a { L, R } pair and index in before calling -
 * see JugglingSimulator.getRenderState / Game.draw), set to the outgoing
 * ball's carry duration.
 */
export function queueSlotIndexForRender(arrayIndex, time, shiftStart, shiftUntil) {
    if (time >= shiftUntil) return arrayIndex;
    if (time <= shiftStart) return arrayIndex + 1;
    const progress = smoothstep((time - shiftStart) / (shiftUntil - shiftStart));
    return arrayIndex + 1 - progress;
}

/**
 * World position of the i-th ball (0 = innermost/next-to-throw) queued under
 * `hand`. Index 0 always lands exactly on that hand's outer catch spot - the
 * same point Throw's carry curve starts from - so a queue's innermost ball
 * never has to jump anywhere when it's actually thrown.
 */
export function queueSlotPosition(hands, handY, ballRadius, hand, index) {
    const dir = hand === 'R' ? 1 : -1;
    return {
        x: hands[hand].outerX + dir * ballRadius * QUEUE_SPACING_RADII * index,
        y: handY,
    };
}
