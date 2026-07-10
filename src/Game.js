import JugglingSimulator from './JugglingSimulator.js';
import Ball from './Ball.js';
import Throw from './Throw.js';
import KeyboardInput from './KeyboardInput.js';
import { queueSlotPosition, queueSlotIndexForRender, QUEUE_SPACING_RADII } from './HandQueue.js';
import { getAvailableHeights, computeLitRings, chargePastCancelThreshold, chargeInCancelFlash, chargeWedgeHidden } from './ThrowHeight.js';

const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

// How long (wall-clock ms) to honor a throw release that arrived while the
// hand's queue was still empty - e.g. the player released just before the
// inbound ball landed. Checked when a ball becomes available (see
// tryPendingThrow).
const THROW_GRACE_MS = 160;

/**
 * Everything that happens once the player commits to "Let me try!": the
 * static ghost-path preview/beat cue (unchanged from before), plus - new -
 * letting the player actually throw balls. Kept separate from App, which
 * just owns the page's idle-state chrome (see there).
 *
 * Manual throws reuse the exact same Throw geometry as the scripted "Show
 * me" demo (via `this.physics`, a JugglingSimulator instance kept around
 * purely as a source of fixed constants - hand positions, arcPeakFor,
 * carryDuration, etc - never ticked or fed a schedule), so a player-thrown
 * ball's recoil-scoop-launch motion looks identical to the automatic one.
 *
 * Each hand holds a horizontal queue of balls (see this.queues): index 0 is
 * the "innermost" ball, next in line to throw, and sits exactly at that
 * hand's catch position - the same spot Throw's carry curve starts from -
 * so throwing it never has to jump it into place first. Catching adds to
 * the far ("outermost") end; throwing removes from the near end. Only the
 * innermost ball's position ever matters for continuity; the rest of the
 * queue is purely cosmetic bookkeeping (see queuePosition).
 *
 * Throw height is chosen by how long the throw button is held (see
 * this.charging): pressing starts a charge for that hand, releasing within
 * one beat fires at whichever height window was active (see
 * ThrowHeight.computeLitRings). Hold past a full beat and the throw is
 * cancelled on release, after a brief red flash on the wedge UI.
 */
export default class Game {
    constructor(siteswap, { bpm, renderer, $beatBar, $beatBarWrap }) {
        this.renderer = renderer;
        this.$beatBar = $beatBar;
        this.$beatBarWrap = $beatBarWrap;

        // Never ticked with update()/processBeat() as a schedule - only read
        // for its fixed constants (hands.*.outerX/innerX, arcPeakFor,
        // beatDuration, carryDuration, carryLift, handY, ballRadius,
        // timeScale) and, via getGhostPaths(), the practice-mode preview.
        // setBpm() is still called on it (see setBpm below) purely to keep
        // its timeScale in sync, since manual throws borrow that too.
        this.physics = new JugglingSimulator(siteswap, { bpm });
        this.paths = this.physics.getGhostPaths();
        this.period = this.physics.period;
        this.ballRadius = this.physics.ballRadius;
        this.extent = this.buildExtent();
        // The two height "ladders" (crossing: odd, self: even) a held throw
        // can select from, capped at whatever this pattern's tallest throw
        // is - see ThrowHeight and this.charging below.
        const { crossHeights, selfHeights } = getAvailableHeights(this.physics.getMaxHeight());
        this.crossHeights = crossHeights;
        this.selfHeights = selfHeights;

        // Beat bar and ghost-path highlight are driven off this one clock,
        // so dragging the BPM slider can't leave them out of sync with each
        // other (see draw/tick). Independent of manual throw timing below -
        // the whole point of the cue is to show the *target* beat, which the
        // player is free to miss.
        this.beatIndex = 0;
        this.beatElapsed = 0;

        // Simulation time for manually-thrown balls, in the same
        // reference-tempo seconds as this.physics (see JugglingSimulator's
        // own time/timeScale) - advanced the same way in tick(), so a throw
        // triggered right now plays out at exactly the tempo the rest of the
        // app agrees on.
        this.time = 0;
        this.inFlight = [];
        this.queues = this.buildInitialQueues();
        // Per-hand inward-shift window for the live queue - set when the
        // innermost ball is thrown (executeThrow) and read when laying
        // out the queue (draw).
        this.queueShiftStart = { L: -Infinity, R: -Infinity };
        this.queueShiftUntil = { L: -Infinity, R: -Infinity };
        // Per-hand throw intent that didn't fire because the queue was empty
        // - { crossing, height, wallTime } or null (see attemptThrow/tryPendingThrow).
        this.pendingThrow = { L: null, R: null };
        // Per-hand in-progress button hold - { crossing, startWallTime } or
        // null (see handleThrowStart/handleThrowRelease/getChargeState).
        this.charging = { L: null, R: null };

        this.inputSchemes = [new KeyboardInput({
            onThrowStart: (intent) => this.handleThrowStart(intent),
            onThrowRelease: (intent) => this.handleThrowRelease(intent),
        })];

        this.rafId = null;
        this.lastTimestamp = 0;
    }

    /** Splits the pattern's balls round-robin, R first, between the hands' starting queues. */
    buildInitialQueues() {
        const queues = { L: [], R: [] };
        for (let i = 0; i < this.physics.numBalls; i++) {
            const hand = i % 2 === 0 ? 'R' : 'L';
            queues[hand].push(new Ball(i));
        }
        return queues;
    }

    /**
     * Widens JugglingSimulator's own getExtent() to also fit a queue's
     * horizontal spread. Sized for the worst case - every ball crossed into
     * one hand and never crossed back - rather than just the starting
     * layout, since queue length can grow past its initial split during
     * play (see handleThrowInput).
     */
    buildExtent() {
        // JugglingSimulator's own spawn-queue allowance (see its getExtent)
        // is exact but schedule-bound - only ever as deep as the pattern's
        // fixed warm-up requires. Ours has to cover whatever the player does
        // (see handleThrowInput's comment on worst-case queue growth), which
        // can exceed that, so it's computed separately here rather than
        // reusing that term.
        const base = this.physics.getExtent({ includeSpawnQueue: false });
        const maxPossibleQueueLen = Math.max(1, this.physics.numBalls);
        const extraWidth = this.ballRadius * QUEUE_SPACING_RADII * (maxPossibleQueueLen - 1);
        return {
            minX: base.minX - extraWidth,
            maxX: base.maxX + extraWidth,
            minY: base.minY,
            maxY: base.maxY,
        };
    }

    start() {
        this.renderer.fit(this.extent);
        this.$beatBar.css('transform', 'scaleX(1)');
        this.$beatBarWrap.removeClass('hidden');

        for (const scheme of this.inputSchemes) scheme.attach();

        this.lastTimestamp = performance.now();
        this.draw();
        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    setBpm(bpm) {
        // Keeps this.physics.timeScale current - both the beat cue and any
        // in-progress charge's timing (see getChargeState) read tempo
        // through it.
        this.physics.setBpm(bpm);
    }

    /**
     * Starts charging a throw for `hand`: the height it'll actually launch
     * at is only decided on release (see handleThrowRelease), based on how
     * long it was held. A second press on the same hand while one's already
     * charging is ignored - only one throw can be in flight from a hand's
     * queue at a time anyway. Also ignored if this side has no valid height
     * at all (e.g. a self throw when the pattern's tallest throw is only 1).
     */
    handleThrowStart({ hand, crossing }) {
        if (this.charging[hand]) return;
        const heights = crossing ? this.crossHeights : this.selfHeights;
        if (heights.length === 0) return;
        this.charging[hand] = { crossing, startWallTime: performance.now() };
    }

    /**
     * Timing state for an in-progress charge: how many rings are lit,
     * whether the hold has crossed a full beat (cancel on release), whether
     * we're in the brief red-flash window, and whether the wedge is hidden.
     */
    getChargeState(hand) {
        const charge = this.charging[hand];
        if (!charge) return null;
        const heights = charge.crossing ? this.crossHeights : this.selfHeights;
        const elapsedSeconds = (performance.now() - charge.startWallTime) / 1000;
        const beatDurationSeconds = 60 / this.physics.bpm;
        return {
            litRings: computeLitRings(heights.length, elapsedSeconds, beatDurationSeconds),
            cancelled: chargePastCancelThreshold(elapsedSeconds, beatDurationSeconds),
            cancelFlash: chargeInCancelFlash(elapsedSeconds, beatDurationSeconds),
            wedgeHidden: chargeWedgeHidden(elapsedSeconds, beatDurationSeconds),
        };
    }

    /** Stops charging `hand` - fires the throw if still within one beat, otherwise cancels. */
    handleThrowRelease({ hand, crossing }) {
        const charge = this.charging[hand];
        if (!charge || charge.crossing !== crossing) return;
        const state = this.getChargeState(hand);
        this.charging[hand] = null;
        if (state.cancelled) {
            this.draw();
            return;
        }
        const heights = crossing ? this.crossHeights : this.selfHeights;
        const height = heights[state.litRings - 1];
        this.attemptThrow(hand, crossing, height);
        this.draw();
    }

    /**
     * A hand can only throw a ball it's actually holding - i.e. its queue
     * isn't empty. If it's empty right now, buffers the intent (including
     * the already-chosen height) in case a ball lands within the grace
     * window (see tryPendingThrow).
     */
    attemptThrow(hand, crossing, height) {
        this.pendingThrow[hand] = null;
        if (this.queues[hand].length === 0) {
            this.pendingThrow[hand] = { crossing, height, wallTime: performance.now() };
            return;
        }
        this.executeThrow(hand, crossing, height);
    }

    /** Drops any pending throw whose grace window has expired. */
    expirePendingThrows() {
        const now = performance.now();
        for (const hand of ['L', 'R']) {
            const pending = this.pendingThrow[hand];
            if (pending && now - pending.wallTime > THROW_GRACE_MS) {
                this.pendingThrow[hand] = null;
            }
        }
    }

    /**
     * If the player released throw for `hand` just before a ball landed,
     * fire that buffered intent - at its already-chosen height - now that
     * the queue has a ball again.
     */
    tryPendingThrow(hand) {
        const pending = this.pendingThrow[hand];
        if (!pending || this.queues[hand].length === 0) return;
        if (performance.now() - pending.wallTime > THROW_GRACE_MS) {
            this.pendingThrow[hand] = null;
            return;
        }
        this.pendingThrow[hand] = null;
        this.executeThrow(hand, pending.crossing, pending.height);
    }

    /**
     * Throws the innermost ball in `hand`'s queue, identically to a scripted
     * throw: same carry-then-flight geometry, same rest-velocity-matching
     * (whatever it landed with if it's fresh off a catch - see
     * Ball.restVelocity, or the pattern's steady-state landing velocity for
     * a never-flown ball - see getSteadyStateIncoming) so the carry curve
     * continues smoothly and first throws match the ghost paths.
     */
    executeThrow(hand, crossing, height) {
        const queue = this.queues[hand];
        if (queue.length === 0) return;

        const hadQueueBehind = queue.length > 1;
        const ball = queue.shift();
        if (hadQueueBehind) {
            this.queueShiftStart[hand] = this.time;
            this.queueShiftUntil[hand] = this.time + this.physics.carryDuration;
        }
        const destHand = crossing ? this.physics.otherHand(hand) : hand;
        const p = this.physics;

        const incomingVelocity = this.resolveIncomingVelocity(ball, hand, height);

        const flight = new Throw({
            ball,
            startTime: this.time,
            endTime: this.time + height * p.beatDuration,
            catchX: p.hands[hand].outerX,
            releaseX: p.hands[hand].innerX,
            landX: p.hands[destHand].outerX,
            baseY: p.handY,
            arcPeak: p.arcPeakFor(height),
            carryDuration: p.carryDuration,
            carryLift: p.carryLift,
            incomingVelocity,
        });

        this.inFlight.push({ flight, ball, destHand, sourceHand: hand });
    }

    /**
     * What incoming velocity the next carry from `hand` should start with.
     * Landed balls reuse their actual rest velocity; never-flown balls fall
     * back to the ghost-path steady state for the current beat, and if that
     * beat's slot is empty ({0, 0} - the hand doesn't throw then, or the
     * player is off-beat) to a typical catch speed harvested from whichever
     * beat in the pattern gives the steepest scoop for this hand.
     *
     * Height-1 throws are a special case: they land with a much shallower
     * vertical speed than taller throws, so feeding that rest velocity
     * straight back into the next 1 makes the carry look flat even though
     * the hand should still recoil. When chaining 1s, keep the actual
     * horizontal catch momentum but borrow the pattern's usual downward
     * recoil on the vertical axis (see height check below).
     */
    resolveIncomingVelocity(ball, hand, height) {
        const typical = this.physics.getTypicalSteadyStateIncoming(hand);

        if (ball.restVelocity.x === 0 && ball.restVelocity.y === 0) {
            const atBeat = this.physics.getSteadyStateIncoming(hand, this.beatIndex);
            if (atBeat.x !== 0 || atBeat.y !== 0) return atBeat;
            return typical;
        }

        const rest = ball.restVelocity;
        if (height === 1 && typical.y < 0 && rest.y > typical.y) {
            return { x: rest.x, y: typical.y };
        }
        return rest;
    }

    /** Lands any manually-thrown ball whose flight has finished by now, into the outer end of its destination hand's queue. */
    resolveLandings() {
        for (let i = this.inFlight.length - 1; i >= 0; i--) {
            const entry = this.inFlight[i];
            if (entry.flight.endTime <= this.time) {
                entry.ball.restVelocity = entry.flight.landVelocity;
                this.queues[entry.destHand].push(entry.ball);
                this.inFlight.splice(i, 1);
                this.tryPendingThrow(entry.destHand);
            }
        }
    }

    tick(timestamp) {
        const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
        this.lastTimestamp = timestamp;

        // Sub-step so a single long frame (tab backgrounded, hitch) can't
        // leap past a throw's whole carry phase - especially noticeable on
        // low "1" throws, where carry is a large share of a short duration
        // and the ball never leaves the hand region.
        const delta = dt * this.physics.timeScale;
        const maxStep = this.physics.carryDuration / 8;
        let remaining = delta;
        while (remaining > 0) {
            const step = Math.min(maxStep, remaining);
            this.time += step;
            this.resolveLandings();
            remaining -= step;
        }
        this.expirePendingThrows();

        const beatDuration = 60 / this.physics.bpm;
        this.beatElapsed += dt;
        while (this.beatElapsed >= beatDuration) {
            this.beatElapsed -= beatDuration;
            this.beatIndex = (this.beatIndex + 1) % this.period;
        }
        this.draw();

        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    draw() {
        const beatDuration = 60 / this.physics.bpm;
        const beatProgress = Math.min(this.beatElapsed / beatDuration, 1);
        this.$beatBar.css('transform', `scaleX(${1 - beatProgress})`);

        const balls = [];
        const carryingFrom = { L: false, R: false };
        for (const entry of this.inFlight) {
            if (entry.sourceHand && this.time - entry.flight.startTime < entry.flight.carryDuration) {
                carryingFrom[entry.sourceHand] = true;
            }
        }
        for (const hand of ['L', 'R']) {
            const queue = this.queues[hand];
            for (let i = 0; i < queue.length; i++) {
                // While a ball is still in its carry phase, hide the
                // innermost queued ball sliding into the catch spot -
                // otherwise a low "1" throw (which never leaves the hand
                // region) can look like the queue ball doing a flat slide
                // with no scoop.
                if (i === 0 && carryingFrom[hand]) continue;
                const slot = queueSlotIndexForRender(
                    i, this.time, this.queueShiftStart[hand], this.queueShiftUntil[hand],
                );
                const pos = queueSlotPosition(this.physics.hands, this.physics.handY, this.ballRadius, hand, slot);
                balls.push({ x: pos.x, y: pos.y, radius: this.ballRadius, color: queue[i].color });
            }
        }
        for (const entry of this.inFlight) {
            const pos = entry.flight.positionAt(this.time);
            balls.push({ x: pos.x, y: pos.y, radius: this.ballRadius, color: entry.ball.color });
        }

        const wedges = [];
        for (const hand of ['L', 'R']) {
            const charge = this.charging[hand];
            if (!charge) continue;
            const anchor = this.renderer.worldToScreen(this.physics.hands[hand].outerX, this.physics.handY);
            const state = this.getChargeState(hand);
            if (state.wedgeHidden) continue;
            wedges.push({
                hand,
                anchor,
                crossHeights: this.crossHeights,
                selfHeights: this.selfHeights,
                activeSide: charge.crossing ? 'cross' : 'self',
                litRings: state.litRings,
                cancelFlash: state.cancelFlash,
            });
        }

        this.renderer.draw({
            balls,
            staticPaths: this.paths.map((path) => ({
                points: path.points,
                highlighted: path.beat === this.beatIndex,
            })),
            ballRadius: this.ballRadius,
            wedges,
        });
    }

    /** Re-fit and redraw against the same fixed geometry (e.g. on resize). */
    handleResize() {
        this.renderer.fit(this.extent);
        this.draw();
    }

    stop() {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        for (const scheme of this.inputSchemes) scheme.detach();
        this.charging = { L: null, R: null };
        this.$beatBarWrap.addClass('hidden');
    }
}
