import Ball from './Ball.js';
import Throw from './Throw.js';
import { queueSlotPosition, queueSlotIndexForRender, QUEUE_SPACING_RADII } from './HandQueue.js';

// The simulation always runs its physics at this fixed internal tempo. BPM is
// applied purely as a playback-rate multiplier (see setBpm/update), never by
// re-deriving beat spacing or gravity. That keeps arc heights identical at any
// tempo (we replay one fixed trajectory faster or slower) and makes tempo
// changes seamless: nothing in flight has to be reconciled with a moved clock.
const REFERENCE_BPM = 200;

// Tolerance for the endTime <= uptoTime landing check. A throw's endTime and
// a beat boundary it should land exactly on are computed via slightly
// different arithmetic (one accumulates a running time, the other multiplies
// a beat index by beatDuration), so they can differ by a floating-point
// rounding hair even though they're conceptually identical instants. Without
// this slack, getGhostPaths() - which checks landings at exactly each beat's
// own computed time - can occasionally miss a landing by that hair and
// silently skip the beat's throw entirely (its hand finds no ball waiting).
const LANDING_EPSILON = 1e-9;

// How many evenly-spaced dots to lay down each time recordTrails decides to
// record (see there) - a plain multiplier applied uniformly at every tempo,
// so it thickens the trail overall without disturbing the balance between
// tempos.
const DOTS_PER_RECORDED_FRAME = 2;

/**
 * Which hand each of the pattern's numBalls balls will be spawned into, in
 * spawn order - i.e. exactly replaying executeThrow's own "does this hand
 * already have a ball, and if not, spawn one" decision (see there), but in
 * abstract beat-integer units and without creating any real Ball/Throw
 * objects, purely to know in advance where a not-yet-spawned ball's queue
 * placeholder belongs (see getRenderState/getExtent). Every siteswap height
 * is a whole number of beats, so tracking landings as `beat + height` and
 * comparing with plain `<=` is exact - no floating-point landing slop needed
 * here the way resolveLandings needs LANDING_EPSILON.
 */
function computeSpawnOrder(slots, period, numBalls) {
    const holding = { R: false, L: false };
    const inFlight = []; // { landBeat, destHand }
    const spawnOrder = [];
    let beat = 0;
    while (spawnOrder.length < numBalls) {
        for (let i = inFlight.length - 1; i >= 0; i--) {
            if (inFlight[i].landBeat <= beat) {
                holding[inFlight[i].destHand] = true;
                inFlight.splice(i, 1);
            }
        }
        const slot = slots[beat % period];
        for (const hand of ['R', 'L']) {
            const throwSpec = slot[hand];
            if (!throwSpec) continue;
            if (holding[hand]) {
                holding[hand] = false;
            } else if (spawnOrder.length < numBalls) {
                spawnOrder.push(hand);
            }
            const destHand = throwSpec.crossing ? (hand === 'R' ? 'L' : 'R') : hand;
            inFlight.push({ landBeat: beat + throwSpec.height, destHand });
        }
        beat += 1;
    }
    return spawnOrder;
}

/**
 * Drives a juggling pattern from a notation-neutral schedule. Works in abstract
 * world units and continuous time so that later features (arbitrary-height,
 * arbitrary-timing player throws) can feed events through the same path without
 * changing this class.
 *
 * Coordinate system: origin between the hands, x to the right, y up. Hands sit
 * at y = 0; throws arc upward.
 */
export default class JugglingSimulator {
    constructor(siteswap, {
        bpm = 200, ballRadius = 0.12, gravity = 20, _skipSteadyStateProbe = false,
        // Optional hooks for a soundtrack (or anything else) that wants to
        // react to real, live-playback beats/throws - see processBeat/
        // executeThrow below. Never fired during getGhostPaths's own
        // warm-up/harvest (see _buildingSteadyState), nor on the separate
        // probe instance _ensureSteadyStateIncoming builds (which never
        // receives these options at all), so silent bookkeeping runs never
        // make noise.
        onBeat = null, onThrow = null,
    } = {}) {
        this._siteswap = siteswap;
        this._steadyStateOpts = { bpm, ballRadius, gravity, _skipSteadyStateProbe: true };
        this.onBeat = onBeat;
        this.onThrow = onThrow;
        const schedule = siteswap.toSchedule();
        this.period = schedule.period;
        this.numBalls = schedule.numBalls;
        this.slots = schedule.slots;
        // "One full cycle" for music purposes (see processBeat's isNewPeriod
        // and Game's soundtrackEffectivePeriod) isn't always this.period
        // beats - a pattern like "3" repeats every single beat but still has
        // 3 distinct balls, so waiting only this.period beats between chords
        // would step the progression well before every ball's actually been
        // thrown once. Never shorter than this.period itself, just padded up
        // to numBalls when the pattern alone would be too short.
        this.effectivePeriodForMusic = Math.max(this.period, this.numBalls);
        // Which hand each ball will be fed into, in spawn order - fixed for
        // the pattern's whole life, used only to lay out not-yet-spawned
        // balls as a waiting queue (see getRenderState/getExtent).
        this.spawnOrder = computeSpawnOrder(this.slots, this.period, this.numBalls);

        this.ballRadius = ballRadius;

        // Physics constants, fixed at the reference tempo for the simulator's
        // whole life. beatDuration here is internal ("reference seconds"); the
        // wall-clock tempo is applied later via timeScale in update().
        this.beatDuration = 60 / REFERENCE_BPM;
        // Fixed share of a beat spent in the inward hand sweep, since it's a
        // hand motion rather than a scaled physical fall.
        this.carryDuration = this.beatDuration * 0.42;
        this.gravity = gravity;

        // Wider stance for more balls so trajectories stay legible.
        this.handSpacing = Math.max(1, this.numBalls * 0.5);
        this.handY = 0;
        // Each hand has an outer "catch" spot and an inner "release" spot it
        // sweeps the ball toward before throwing (see Throw for why the split).
        const outerR = this.handSpacing / 2;
        const innerRatio = 0.25;
        // incomingVelocity is what the carry's Bezier leaves the catch point
        // with - {0, 0} until a real landing gives it something to match.
        this.hands = {
            R: { outerX: outerR, innerX: outerR * innerRatio, ball: null, incomingVelocity: { x: 0, y: 0 } },
            L: { outerX: -outerR, innerX: -outerR * innerRatio, ball: null, incomingVelocity: { x: 0, y: 0 } },
        };
        this.carryLift = this.handSpacing * 0.1;

        // Internal simulation time, in reference-tempo seconds. It advances at
        // timeScale x wall-clock (see update); the physics above are unaware of
        // the current BPM entirely.
        this.time = 0;
        this.timeScale = 1;
        this.nextBeat = 0;
        this.nextBeatTime = 0;
        this.inFlight = [];
        this.spawned = 0;
        // Every ball ever spawned, so trail bookkeeping can visit balls
        // uniformly whether they're currently flying or resting in a hand.
        this.balls = [];
        // Counts calls to update(), i.e. animation frames - used to thin out
        // trail recording at lower tempos (see recordTrails).
        this.frameCount = 0;
        // Per-hand inward-shift window for the spawn queue - set when the
        // innermost queued ball is fed into the pattern (executeThrow) and
        // read when laying out the queue (getRenderState).
        this.queueShiftStart = { L: -Infinity, R: -Infinity };
        this.queueShiftUntil = { L: -Infinity, R: -Infinity };
        // Per (beat-in-period, hand) incoming velocity once the pattern has
        // settled - harvested by getGhostPaths (see there) and used to seed
        // spawn/first throws so their carry matches the ghost paths.
        this.steadyStateIncoming = null;
        // True while getGhostPaths is driving warm-up/harvest on this
        // instance - spawn throws during that window must stay at rest so we
        // don't recurse into another probe sim while building the map.
        this._buildingSteadyState = false;

        this.setBpm(bpm);
    }

    _ensureSteadyStateIncoming() {
        if (this.steadyStateIncoming || this._buildingSteadyState) return;
        const probe = new JugglingSimulator(this._siteswap, this._steadyStateOpts);
        probe.getGhostPaths();
        this.steadyStateIncoming = probe.steadyStateIncoming;
    }

    /**
     * Steady-state catch velocity for a throw from `hand` on beat
     * `beatIndex` (mod period) - i.e. what the ghost paths assume the hand
     * is recoiling from. Falls back to rest if the map hasn't been built yet
     * or this slot never throws.
     */
    getSteadyStateIncoming(hand, beatIndex) {
        this._ensureSteadyStateIncoming();
        if (!this.steadyStateIncoming) return { x: 0, y: 0 };
        const rel = ((beatIndex % this.period) + this.period) % this.period;
        const entry = this.steadyStateIncoming[rel]?.[hand];
        return entry ? { x: entry.x, y: entry.y } : { x: 0, y: 0 };
    }

    /**
     * A representative catch velocity for `hand` drawn from whichever beat
     * in the pattern gives the steepest downward incoming speed. Used when
     * the current beat's slot is {0, 0} - e.g. a hand that doesn't throw
     * on this beat, or a ball's first launch before it's ever landed - so
     * manual throws still get a visible recoil scoop instead of starting
     * from a dead stop (see Game.resolveIncomingVelocity).
     */
    getTypicalSteadyStateIncoming(hand) {
        this._ensureSteadyStateIncoming();
        if (!this.steadyStateIncoming) return { x: 0, y: 0 };
        let best = { x: 0, y: 0 };
        let bestMag = 0;
        for (let beat = 0; beat < this.period; beat++) {
            const entry = this.steadyStateIncoming[beat]?.[hand];
            if (!entry) continue;
            const mag = Math.abs(entry.y);
            if (mag > bestMag) {
                best = { x: entry.x, y: entry.y };
                bestMag = mag;
            }
        }
        return best;
    }

    /**
     * Sets the tempo. This only changes how fast internal time advances - it
     * never touches beat spacing, gravity, or anything already in flight. So a
     * change mid-run is perfectly seamless: every ball simply continues along
     * its exact same trajectory, faster or slower. Because the physics stay
     * pinned to REFERENCE_BPM, arc heights are identical at any tempo.
     */
    setBpm(bpm) {
        this.bpm = bpm;
        this.timeScale = bpm / REFERENCE_BPM;
    }

    otherHand(hand) {
        return hand === 'R' ? 'L' : 'R';
    }

    arcPeakFor(height) {
        // Peak height of a parabola that spends exactly `flightDuration`
        // aloft under one consistent gravity: h = g*T^2/8 (the standard
        // relation for a projectile's peak height given its total airtime).
        // Deriving arcPeak this way - rather than an arbitrary per-height
        // scale factor - means every throw in the pattern, however tall,
        // falls under the *same* gravity instead of each height silently
        // getting its own slightly different effective acceleration.
        const flightDuration = height * this.beatDuration - this.carryDuration;
        if (flightDuration <= 0) return 0;
        return (this.gravity * flightDuration * flightDuration) / 8;
    }

    update(dtSeconds) {
        // Advance internal time at the current playback rate. Everything below
        // works in this scaled time, so tempo affects only the pace, never the
        // geometry, of the pattern.
        this.time += dtSeconds * this.timeScale;

        this.resolveLandings(this.time);

        while (this.nextBeatTime <= this.time) {
            this.processBeat(this.nextBeat, this.nextBeatTime);
            this.nextBeat += 1;
            this.nextBeatTime += this.beatDuration;
        }

        this.recordTrails();
    }

    /**
     * Resolves any in-flight throw whose endTime has passed uptoTime: hands
     * it to its destination hand and records the velocity it landed with, so
     * the next carry that hand builds leaves the catch point on that same
     * trajectory instead of snapping to rest. Since beat spacing is fixed, a
     * throw's endTime lands exactly on the beat that re-throws it, so catch
     * and re-throw stay in lockstep at every tempo. Split out from update()
     * so getGhostPaths() can drive the same landing logic synchronously,
     * beat by beat, without going through a live animation clock at all.
     */
    resolveLandings(uptoTime) {
        for (let i = this.inFlight.length - 1; i >= 0; i--) {
            const entry = this.inFlight[i];
            if (entry.flight.endTime <= uptoTime + LANDING_EPSILON) {
                const hand = this.hands[entry.destHand];
                hand.ball = entry.ball;
                hand.incomingVelocity = entry.flight.landVelocity;
                this.inFlight.splice(i, 1);
            }
        }
    }

    /**
     * Appends this instant's position to each flying ball's own trail, then
     * trims every ball's trail to its current window. Recording (not just
     * trimming) only happens for balls actually in flight - a resting ball's
     * last few flight samples are left to simply age out - but trimming
     * covers every ball, flying or resting, so a trail persists smoothly
     * through the catch instant instead of vanishing the moment a ball
     * lands, then rebuilding from nothing once it's thrown again.
     *
     * At most one recorded frame per animation frame, and fewer still at
     * lower tempos - skipping `REFERENCE_BPM / bpm` frames between recorded
     * ones - so a slow-motion pattern doesn't pack in as many dots as a fast
     * one covering the same ground. Each recorded frame lays down
     * DOTS_PER_RECORDED_FRAME dots spanning back to the last one (rather
     * than a single dot right at this instant), both to thicken the trail a
     * bit and to fill in, rather than skip past, whatever ground was
     * covered on the frames in between.
     */
    recordTrails() {
        this.frameCount += 1;
        const frameSkip = Math.max(1, Math.round(REFERENCE_BPM / this.bpm));
        if (this.frameCount % frameSkip === 0) {
            for (const entry of this.inFlight) {
                const ball = entry.ball;
                const from = Number.isFinite(ball.lastTrailSampleTime) ? ball.lastTrailSampleTime : this.time;
                for (let i = 1; i <= DOTS_PER_RECORDED_FRAME; i++) {
                    const t = from + (this.time - from) * (i / DOTS_PER_RECORDED_FRAME);
                    const pos = entry.flight.positionAt(t);
                    ball.trail.push({ time: t, x: pos.x, y: pos.y });
                }
                ball.lastTrailSampleTime = this.time;
            }
        }
        for (const ball of this.balls) {
            const cutoff = this.time - ball.trailWindow;
            let dropCount = 0;
            while (dropCount < ball.trail.length && ball.trail[dropCount].time < cutoff) {
                dropCount += 1;
            }
            if (dropCount > 0) ball.trail.splice(0, dropCount);
        }
    }

    processBeat(beat, beatTime) {
        // Fires for every beat, whether or not either hand actually throws
        // on it (a siteswap "0" rest beat still keeps the pulse going) -
        // see the onBeat option above. First argument is the real-world
        // length of one beat at the current (live) tempo, not
        // this.beatDuration (fixed at REFERENCE_BPM - see setBpm), so a
        // soundtrack listener can subdivide it correctly regardless of BPM.
        // Second is whether this beat starts a new music-cycle (beat 0
        // doesn't count - nothing has actually cycled yet), for a
        // soundtrack listener to step a chord progression on (see
        // Soundtrack.advancePeriod) - not fired on the same beat as the
        // cycle's own last throws (which still belong to the cycle that
        // just ended), but on the very next one, before its own throws
        // below happen. Measured in effectivePeriodForMusic beats, not
        // this.period, so a short-period/many-ball pattern still gets a
        // chance for every ball to have been thrown before the chord moves
        // on (see effectivePeriodForMusic above).
        if (!this._buildingSteadyState && this.onBeat) {
            const isNewPeriod = beat > 0 && beat % this.effectivePeriodForMusic === 0;
            this.onBeat(60 / this.bpm, isNewPeriod);
        }

        // Execute this beat's scheduled throw(s). The schedule names which
        // hand(s) act rather than us inferring it from beat parity, since a
        // synchronous beat has both hands throwing at once.
        const slot = this.slots[beat % this.period];
        if (slot.R) this.executeThrow(beat, beatTime, 'R', slot.R);
        if (slot.L) this.executeThrow(beat, beatTime, 'L', slot.L);
    }

    executeThrow(beat, beatTime, sourceHand, throwSpec) {
        const destHand = throwSpec.crossing ? this.otherHand(sourceHand) : sourceHand;
        const hand = this.hands[sourceHand];

        // Feed balls in one at a time as the pattern establishes itself.
        if (!hand.ball) {
            if (this.spawned < this.numBalls) {
                const hasQueueBehind = this.spawnOrder
                    .slice(this.spawned + 1)
                    .some((h) => h === sourceHand);
                hand.ball = new Ball(this.spawned);
                this.balls.push(hand.ball);
                hand.incomingVelocity = this.getSteadyStateIncoming(sourceHand, beat);
                this.spawned += 1;
                if (hasQueueBehind) {
                    this.queueShiftStart[sourceHand] = beatTime;
                    this.queueShiftUntil[sourceHand] = beatTime + this.carryDuration;
                }
            } else {
                return; // Should not happen for a validated pattern.
            }
        }

        const ball = hand.ball;
        const incomingVelocity = hand.incomingVelocity;
        hand.ball = null;

        const flight = new Throw({
            ball,
            startTime: beatTime,
            endTime: beatTime + throwSpec.height * this.beatDuration,
            catchX: hand.outerX,
            releaseX: hand.innerX,
            landX: this.hands[destHand].outerX,
            baseY: this.handY,
            arcPeak: this.arcPeakFor(throwSpec.height),
            carryDuration: this.carryDuration,
            carryLift: this.carryLift,
            incomingVelocity,
        });
        // Governs how long this ball's trail stays visible, including after
        // it lands - re-set on every throw so a lazy high throw still gets a
        // proportionally longer trail than a quick low one (see recordTrails).
        ball.trailWindow = flight.duration * 0.33;

        this.inFlight.push({
            flight,
            ball,
            destHand,
        });

        if (!this._buildingSteadyState && this.onThrow) {
            // Real-world seconds until this ball is caught again - height
            // beats at the *current* (possibly since-changed) tempo, not
            // this.beatDuration, which is fixed at REFERENCE_BPM (see
            // setBpm) - so the tone's fade (see Soundtrack.playThrow) always
            // lands on the actual catch, at whatever speed is live right now.
            const durationSeconds = (throwSpec.height * 60) / this.bpm;
            this.onThrow({ hand: sourceHand, height: throwSpec.height, durationSeconds });
        }
    }

    getRenderState() {
        const balls = [];
        for (const entry of this.inFlight) {
            const pos = entry.flight.positionAt(this.time);
            balls.push({
                id: entry.ball.id,
                x: pos.x,
                y: pos.y,
                radius: this.ballRadius,
                color: entry.ball.color,
            });
        }
        for (const key of ['L', 'R']) {
            const hand = this.hands[key];
            if (hand.ball) {
                balls.push({
                    id: hand.ball.id,
                    x: hand.outerX,
                    y: this.handY,
                    radius: this.ballRadius,
                    color: hand.ball.color,
                });
            }
        }
        // Balls not yet fed into the pattern wait in a queue under whichever
        // hand will eventually spawn them (see computeSpawnOrder) - purely
        // cosmetic since executeThrow spawns for real regardless of whether
        // this queue is ever rendered, but it means the player isn't staring
        // at empty hands while a pattern with many balls first gets going.
        // Not-yet-spawned balls are always exactly the suffix
        // [this.spawned, numBalls) of spawnOrder, so their depth within
        // their hand's queue is just their count of same-hand predecessors
        // still in that suffix.
        const queueDepth = { R: 0, L: 0 };
        for (let id = this.spawned; id < this.numBalls; id++) {
            const hand = this.spawnOrder[id];
            const slot = queueSlotIndexForRender(
                queueDepth[hand], this.time, this.queueShiftStart[hand], this.queueShiftUntil[hand],
            );
            const pos = queueSlotPosition(this.hands, this.handY, this.ballRadius, hand, slot);
            balls.push({ id, x: pos.x, y: pos.y, radius: this.ballRadius, color: Ball.colorFor(id) });
            queueDepth[hand] += 1;
        }
        // Each ball owns its own trail (see recordTrails), kept up to date
        // whether the ball is flying or resting, so it fades out smoothly
        // rather than disappearing the instant a ball is caught.
        const trails = this.balls.map((ball) => ball.trail).filter((trail) => trail.length >= 2);
        return { balls, trails, ballRadius: this.ballRadius };
    }

    /**
     * The static "ghost" path every throw in the pattern should trace, all at
     * once, for a preview/practice view where nothing is actually animated.
     * Never call this on a simulator you're also ticking with update() -
     * it drives this.processBeat/resolveLandings directly, on its own
     * synchronous beat-by-beat clock, to fully settle the pattern first.
     *
     * A throw's landVelocity depends only on its own slot's fixed geometry
     * (see Throw.landVelocity) - never on how the ball was caught - so once
     * every ball has entered circulation, the very next full period's throws
     * already have exactly the steady-state incoming velocity real
     * gameplay would produce, with no extra settling time needed. Warm-up
     * simply runs beats until every ball has spawned in, rounds up to the
     * next period boundary (so the harvested cycle starts clean rather than
     * mid-pattern), then simulates one further complete period and returns
     * that period's throws.
     *
     * Each returned path is tagged with `beat` - its offset (0..period-1)
     * within that harvested period - plus the `hand`, `crossing`, and
     * `height` of the scripted throw it depicts, and comes back in
     * chronological (beat, then within-beat R-before-L) order, i.e. exactly
     * the pattern's own throw sequence for one full period. A caller can
     * match paths to the live beat count for a simple "whichever throw
     * happens this beat" cue, or - as Game does - track a pointer through
     * this same order independent of the clock, advancing it only when a
     * live throw's own hand/crossing/height matches the next entry.
     */
    getGhostPaths() {
        this._buildingSteadyState = true;
        try {
        let beat = 0;
        while (this.spawned < this.numBalls) {
            const beatTime = beat * this.beatDuration;
            this.resolveLandings(beatTime);
            this.processBeat(beat, beatTime);
            beat += 1;
        }

        // Collect each harvest-window throw at the moment executeThrow
        // creates it (a fresh entry always lands at the end of inFlight),
        // rather than reading whatever remains in inFlight once the loop
        // ends - a short throw made early in the window may well have
        // already landed, and been removed by resolveLandings, before later
        // beats in the same window even run.
        const harvestStartBeat = Math.ceil(beat / this.period) * this.period;
        const harvestEndBeat = harvestStartBeat + this.period;
        const harvested = [];
        this.steadyStateIncoming = [];
        for (; beat < harvestEndBeat; beat++) {
            const beatTime = beat * this.beatDuration;
            this.resolveLandings(beatTime);
            if (beat >= harvestStartBeat) {
                const relativeBeat = beat - harvestStartBeat;
                const slot = this.slots[beat % this.period];
                for (const hand of ['R', 'L']) {
                    if (!slot[hand]) continue;
                    if (!this.steadyStateIncoming[relativeBeat]) {
                        this.steadyStateIncoming[relativeBeat] = {};
                    }
                    const incoming = this.hands[hand].incomingVelocity;
                    this.steadyStateIncoming[relativeBeat][hand] = {
                        x: incoming.x,
                        y: incoming.y,
                    };
                }
            }
            const before = this.inFlight.length;
            this.processBeat(beat, beatTime);
            if (beat >= harvestStartBeat) {
                const relativeBeat = beat - harvestStartBeat;
                // processBeat executes slot.R then slot.L (see there), so the
                // newly-appended inFlight entries land in that same order -
                // zip them back up with which hand/crossing/height each one
                // came from, so callers can match a live throw attempt
                // against its scripted counterpart (see Game's throw-order
                // tracking) without re-deriving it from the raw path alone.
                const slot = this.slots[beat % this.period];
                const throwOrder = [];
                if (slot.R) throwOrder.push({ hand: 'R', crossing: slot.R.crossing, height: slot.R.height });
                if (slot.L) throwOrder.push({ hand: 'L', crossing: slot.L.crossing, height: slot.L.height });
                this.inFlight.slice(before).forEach((entry, i) => {
                    harvested.push({ beat: relativeBeat, ...throwOrder[i], entry });
                });
            }
        }

        return harvested.map(({ beat: relativeBeat, hand, crossing, height, entry }) => ({
            beat: relativeBeat,
            hand,
            crossing,
            height,
            points: entry.flight.samplePath(),
        }));
        } finally {
            this._buildingSteadyState = false;
        }
    }

    /**
     * World-space bounding box of everything the pattern can reach. The renderer
     * uses this to fit the view; it is also the hook for future auto-zoom driven
     * by ball count and max throw height.
     */
    /**
     * `includeSpawnQueue` defaults on for "Show me" (via App), which relies
     * on this to size the one static fit its whole run uses around the
     * not-yet-spawned queue's initial width. Game passes false: it needs a
     * much larger (worst-case, unbounded-by-schedule) queue allowance of its
     * own regardless (see Game.buildExtent), so including this fixed,
     * schedule-derived term here too would just pad the same margin twice.
     */
    /** The tallest throw (in beats) this pattern ever calls for, on either hand. */
    getMaxHeight() {
        let maxHeight = 0;
        for (const slot of this.slots) {
            for (const throwSpec of [slot.R, slot.L]) {
                if (throwSpec) maxHeight = Math.max(maxHeight, throwSpec.height);
            }
        }
        return maxHeight;
    }

    getExtent({ includeSpawnQueue = true } = {}) {
        const maxHeight = this.getMaxHeight();
        let maxDip = 0;
        for (const slot of this.slots) {
            for (const throwSpec of [slot.R, slot.L]) {
                if (!throwSpec) continue;
                const height = throwSpec.height;
                // The recoil dip is driven by how steeply the ball was
                // falling when caught (see Throw.carryPositionAt); estimate
                // its size from this throw's own landing velocity as a
                // stand-in for "whatever throw lands in this slot's hand next".
                const flightDuration = height * this.beatDuration - this.carryDuration;
                if (flightDuration <= 0) continue;
                const landVy = (-this.carryLift - 4 * this.arcPeakFor(height)) / flightDuration;
                maxDip = Math.max(maxDip, (Math.abs(landVy) * this.carryDuration) / 3);
            }
        }
        const margin = this.ballRadius * 2;
        const topY = this.handY + Math.max(this.arcPeakFor(maxHeight), this.carryLift);
        const bottomY = this.handY - maxDip;
        // Carry/flight never travels outside each hand's outer catch position.
        let halfWidth = this.handSpacing / 2 + margin;

        if (includeSpawnQueue) {
            // The not-yet-spawned queue (see getRenderState) is deepest at
            // time zero, before any spawning has shrunk it, when it holds
            // every ball ultimately assigned to that hand - a plain count
            // over the fixed spawnOrder, no simulation needed. It can only
            // shrink from there, so this is an exact bound, not a
            // conservative guess.
            let maxQueueDepth = 0;
            for (const hand of ['R', 'L']) {
                const depth = this.spawnOrder.filter((h) => h === hand).length;
                maxQueueDepth = Math.max(maxQueueDepth, depth);
            }
            halfWidth += this.ballRadius * QUEUE_SPACING_RADII * Math.max(0, maxQueueDepth - 1);
        }

        return {
            minX: -halfWidth,
            maxX: halfWidth,
            minY: bottomY - margin,
            maxY: topY + margin,
        };
    }
}
