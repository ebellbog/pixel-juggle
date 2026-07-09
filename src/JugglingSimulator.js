import Ball from './Ball.js';
import Throw from './Throw.js';

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

        this.beatDuration = 60 / bpm;
        this.ballRadius = ballRadius;
        // One real gravitational constant (world units/sec^2) governing every
        // throw in the pattern, rather than a per-height scale factor - see
        // arcPeakFor for why that distinction matters.
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

        // Fixed real-world duration for the inward sweep, regardless of throw
        // height, since it's a hand motion rather than a scaled physical fall.
        this.carryDuration = this.beatDuration * 0.42;
        this.carryLift = this.handSpacing * 0.1;

        this.time = 0;
        this.nextBeat = 0;
        this.inFlight = [];
        this.spawned = 0;
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
        this.time += dtSeconds;
        const currentBeat = this.time / this.beatDuration;
        while (this.nextBeat <= currentBeat) {
            this.processBeat(this.nextBeat);
            this.nextBeat += 1;
        }
    }

    processBeat(beat) {
        // 1. Resolve any landings first so an arriving ball can be re-thrown.
        for (let i = this.inFlight.length - 1; i >= 0; i--) {
            const entry = this.inFlight[i];
            if (entry.endBeat === beat) {
                const hand = this.hands[entry.destHand];
                hand.ball = entry.ball;
                // Remember how fast/which-way it was moving so the next carry
                // this hand builds leaves the catch point on that same
                // trajectory instead of snapping to rest.
                hand.incomingVelocity = entry.flight.landVelocity;
                this.inFlight.splice(i, 1);
            }
        }

        // 2. Execute this beat's scheduled throw(s). The schedule names which
        // hand(s) act rather than us inferring it from beat parity, since a
        // synchronous beat has both hands throwing at once.
        const slot = this.slots[beat % this.period];
        if (slot.R) this.executeThrow(beat, 'R', slot.R);
        if (slot.L) this.executeThrow(beat, 'L', slot.L);
    }

    executeThrow(beat, sourceHand, throwSpec) {
        const destHand = throwSpec.crossing ? this.otherHand(sourceHand) : sourceHand;
        const hand = this.hands[sourceHand];

        // Feed balls in one at a time as the pattern establishes itself.
        if (!hand.ball) {
            if (this.spawned < this.numBalls) {
                hand.ball = new Ball(this.spawned);
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
            startTime: beat * this.beatDuration,
            endTime: (beat + throwSpec.height) * this.beatDuration,
            catchX: hand.outerX,
            releaseX: hand.innerX,
            landX: this.hands[destHand].outerX,
            baseY: this.handY,
            arcPeak: this.arcPeakFor(throwSpec.height),
            carryDuration: this.carryDuration,
            carryLift: this.carryLift,
            incomingVelocity,
        });

        this.inFlight.push({
            flight,
            ball,
            endBeat: beat + throwSpec.height,
            destHand,
        });
    }

    getRenderState() {
        const balls = [];
        const trails = [];
        for (const entry of this.inFlight) {
            const pos = entry.flight.positionAt(this.time);
            balls.push({
                x: pos.x,
                y: pos.y,
                radius: this.ballRadius,
                color: entry.ball.color,
            });
            trails.push(this.sampleTrail(entry.flight));
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
        return { balls, trails };
    }

    /**
     * Only the already-traveled portion of a throw's path, oldest point
     * first and ending exactly at the ball's current position - a comet
     * trail behind the ball rather than a preview of where it's headed. The
     * renderer fades it out along its length. Trail length scales with each
     * throw's own duration (rather than a fixed time) so a lazy high throw
     * gets a proportionally longer tail than a quick low one.
     *
     * The carry and flight portions of this window get their own fixed
     * sample budgets (rather than one budget spread evenly over whatever
     * time span the window happens to cover). Otherwise, whenever the
     * window straddles the carry/flight boundary, only a couple of samples
     * land inside the tightly-curved carry - and since the window slides
     * every frame, exactly where those few samples land keeps shifting,
     * which reads as the path jiggling right around the release point.
     */
    sampleTrail(flight, { carrySteps = 8, flightSteps = 16 } = {}) {
        const trailDuration = flight.duration * 0.33;
        const earliest = Math.max(flight.startTime, this.time - trailDuration);
        const carryEnd = flight.startTime + flight.carryDuration;
        const points = [];

        if (earliest < carryEnd) {
            const from = earliest;
            const to = Math.min(this.time, carryEnd);
            for (let i = 0; i <= carrySteps; i++) {
                points.push(flight.positionAt(from + (i / carrySteps) * (to - from)));
            }
        }

        if (this.time > carryEnd) {
            const from = Math.max(earliest, carryEnd);
            const to = this.time;
            // Skip index 0 when the carry loop already placed a point here,
            // so the seam isn't duplicated.
            const startI = points.length > 0 ? 1 : 0;
            for (let i = startI; i <= flightSteps; i++) {
                points.push(flight.positionAt(from + (i / flightSteps) * (to - from)));
            }
        }

        return points;
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
