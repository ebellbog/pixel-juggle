import JugglingSimulator from './JugglingSimulator.js';
import Ball from './Ball.js';
import Throw from './Throw.js';
import KeyboardInput from './KeyboardInput.js';
import { queueSlotPosition, queueSlotIndexForRender, QUEUE_SPACING_RADII } from './HandQueue.js';

const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

// How long (wall-clock ms) to honor a throw press that arrived while the
// hand's queue was still empty - e.g. the player hit the button just before
// the inbound ball landed. Checked when a ball becomes available (see
// tryPendingThrow).
const THROW_GRACE_MS = 160;

// Fixed heights for manually-thrown balls, until player-controlled height
// (held-key duration, discretized or continuous) is wired up.
const SELF_THROW_HEIGHT = 2;
const CROSS_THROW_HEIGHT = 3;

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
        // innermost ball is thrown (handleThrowInput) and read when laying
        // out the queue (draw).
        this.queueShiftStart = { L: -Infinity, R: -Infinity };
        this.queueShiftUntil = { L: -Infinity, R: -Infinity };
        // Per-hand throw intent that didn't fire because the queue was empty
        // - { crossing, wallTime } or null (see handleThrowInput/tryPendingThrow).
        this.pendingThrow = { L: null, R: null };

        this.inputSchemes = [new KeyboardInput((intent) => this.handleThrowInput(intent))];

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
        // Keeps this.physics.timeScale current - both the beat cue below and
        // manual throws (see handleThrowInput/tick) read tempo through it.
        this.physics.setBpm(bpm);
    }

    /**
     * A hand can only throw a ball it's actually holding - i.e. its queue
     * isn't empty. Throwing removes the innermost (index 0) ball and gives
     * it a Throw identical in kind to a scripted one: same carry-then-flight
     * geometry, same fixed heights' worth of arc, starting from this ball's
     * current rest velocity (whatever it landed with if it's fresh off a
     * catch - see Ball.restVelocity, or the pattern's steady-state landing
     * velocity for a never-flown ball - see getSteadyStateIncoming) so the
     * carry curve continues smoothly and first throws match the ghost paths.
     */
    handleThrowInput({ hand, crossing }) {
        if (this.queues[hand].length === 0) {
            this.pendingThrow[hand] = { crossing, wallTime: performance.now() };
            return;
        }
        this.pendingThrow[hand] = null;
        this.executeThrow(hand, crossing);
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
     * If the player pressed throw for `hand` just before a ball landed,
     * fire that buffered intent now that the queue has a ball again.
     */
    tryPendingThrow(hand) {
        const pending = this.pendingThrow[hand];
        if (!pending || this.queues[hand].length === 0) return;
        if (performance.now() - pending.wallTime > THROW_GRACE_MS) {
            this.pendingThrow[hand] = null;
            return;
        }
        this.pendingThrow[hand] = null;
        this.executeThrow(hand, pending.crossing);
    }

    executeThrow(hand, crossing) {
        const queue = this.queues[hand];
        if (queue.length === 0) return;

        const hadQueueBehind = queue.length > 1;
        const ball = queue.shift();
        if (hadQueueBehind) {
            this.queueShiftStart[hand] = this.time;
            this.queueShiftUntil[hand] = this.time + this.physics.carryDuration;
        }
        const destHand = crossing ? this.physics.otherHand(hand) : hand;
        const height = crossing ? CROSS_THROW_HEIGHT : SELF_THROW_HEIGHT;
        const p = this.physics;

        const incomingVelocity = (ball.restVelocity.x !== 0 || ball.restVelocity.y !== 0)
            ? ball.restVelocity
            : p.getSteadyStateIncoming(hand, this.beatIndex);

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

        this.inFlight.push({ flight, ball, destHand });
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

        this.time += dt * this.physics.timeScale;
        this.resolveLandings();
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
        for (const hand of ['L', 'R']) {
            const queue = this.queues[hand];
            for (let i = 0; i < queue.length; i++) {
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

        this.renderer.draw({
            balls,
            staticPaths: this.paths.map((path) => ({
                points: path.points,
                highlighted: path.beat === this.beatIndex,
            })),
            ballRadius: this.ballRadius,
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
        this.$beatBarWrap.addClass('hidden');
    }
}
