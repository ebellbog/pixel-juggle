import Ball from './Ball.js';
import Throw from './Throw.js';

// The simulation always runs its physics at this fixed internal tempo. BPM is
// applied purely as a playback-rate multiplier (see setBpm/update), never by
// re-deriving beat spacing or gravity. That keeps arc heights identical at any
// tempo (we replay one fixed trajectory faster or slower) and makes tempo
// changes seamless: nothing in flight has to be reconciled with a moved clock.
const REFERENCE_BPM = 200;

// How many evenly-spaced dots to lay down each time recordTrails decides to
// record (see there) - a plain multiplier applied uniformly at every tempo,
// so it thickens the trail overall without disturbing the balance between
// tempos.
const DOTS_PER_RECORDED_FRAME = 2;

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
    constructor(siteswap, { bpm = 200, ballRadius = 0.12, gravity = 20 } = {}) {
        const schedule = siteswap.toSchedule();
        this.period = schedule.period;
        this.numBalls = schedule.numBalls;
        this.slots = schedule.slots;

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

        this.setBpm(bpm);
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

        // Resolve landings against each throw's own endTime. Since beat spacing
        // is fixed, a throw's endTime lands exactly on the beat that re-throws
        // it, so catch and re-throw stay in lockstep at every tempo.
        for (let i = this.inFlight.length - 1; i >= 0; i--) {
            const entry = this.inFlight[i];
            if (entry.flight.endTime <= this.time) {
                const hand = this.hands[entry.destHand];
                hand.ball = entry.ball;
                // Remember how fast/which-way it was moving so the next carry
                // this hand builds leaves the catch point on that same
                // trajectory instead of snapping to rest.
                hand.incomingVelocity = entry.flight.landVelocity;
                this.inFlight.splice(i, 1);
            }
        }

        while (this.nextBeatTime <= this.time) {
            this.processBeat(this.nextBeat, this.nextBeatTime);
            this.nextBeat += 1;
            this.nextBeatTime += this.beatDuration;
        }

        this.recordTrails();
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
        // Execute this beat's scheduled throw(s). The schedule names which
        // hand(s) act rather than us inferring it from beat parity, since a
        // synchronous beat has both hands throwing at once.
        const slot = this.slots[beat % this.period];
        if (slot.R) this.executeThrow(beatTime, 'R', slot.R);
        if (slot.L) this.executeThrow(beatTime, 'L', slot.L);
    }

    executeThrow(beatTime, sourceHand, throwSpec) {
        const destHand = throwSpec.crossing ? this.otherHand(sourceHand) : sourceHand;
        const hand = this.hands[sourceHand];

        // Feed balls in one at a time as the pattern establishes itself.
        if (!hand.ball) {
            if (this.spawned < this.numBalls) {
                hand.ball = new Ball(this.spawned);
                this.balls.push(hand.ball);
                hand.incomingVelocity = { x: 0, y: 0 };
                this.spawned += 1;
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
    }

    getRenderState() {
        const balls = [];
        for (const entry of this.inFlight) {
            const pos = entry.flight.positionAt(this.time);
            balls.push({
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
                    x: hand.outerX,
                    y: this.handY,
                    radius: this.ballRadius,
                    color: hand.ball.color,
                });
            }
        }
        // Each ball owns its own trail (see recordTrails), kept up to date
        // whether the ball is flying or resting, so it fades out smoothly
        // rather than disappearing the instant a ball is caught.
        const trails = this.balls.map((ball) => ball.trail).filter((trail) => trail.length >= 2);
        return { balls, trails };
    }

    /**
     * World-space bounding box of everything the pattern can reach. The renderer
     * uses this to fit the view; it is also the hook for future auto-zoom driven
     * by ball count and max throw height.
     */
    getExtent() {
        let maxHeight = 0;
        let maxDip = 0;
        for (const slot of this.slots) {
            for (const throwSpec of [slot.R, slot.L]) {
                if (!throwSpec) continue;
                const height = throwSpec.height;
                maxHeight = Math.max(maxHeight, height);
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
        const halfWidth = this.handSpacing / 2 + margin;
        return {
            minX: -halfWidth,
            maxX: halfWidth,
            minY: bottomY - margin,
            maxY: topY + margin,
        };
    }
}
