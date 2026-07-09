/**
 * A single ball's journey from one catch to the next, in world coordinates
 * (y is up). Kept as pure geometry - it knows nothing about beats, hands, or
 * notation - so it works equally well for scripted pattern throws and, later,
 * continuous player-driven throws.
 *
 * Two phases, chosen to be honest about what physics actually governs each:
 *  1. Carry: the ball is still in the hand. On catching, the hand recoils
 *     downward slightly under the ball's weight, then scoops it up and inward
 *     toward a "release" spot, ending a bit above resting height as it
 *     launches the throw. A hand can move however it likes here (it's
 *     actively supporting the ball against gravity), so this is a smooth
 *     Bezier curve rather than anything ballistic. Its tangents are pinned to
 *     the ball's actual incoming velocity (whatever it was caught with) and
 *     to the outgoing velocity this throw's flight requires at launch, so
 *     motion is continuous - not just position - across catch, carry, and
 *     release.
 *  2. Flight: from the moment of release, only gravity acts. Horizontal
 *     velocity is therefore constant (a straight line to the next catch
 *     point), and height follows a true parabola - possibly asymmetric,
 *     since the release point sits a bit higher than the catch point, just
 *     like a real toss - but still just one continuous quadratic curve, with
 *     no mid-air reversals.
 * The flight starts exactly where the carry ends, at exactly the velocity the
 * carry was aiming for, so the whole path is continuous in both position and
 * velocity.
 */
export default class Throw {
    constructor({
        ball,
        startTime,
        endTime,
        catchX,
        releaseX,
        landX,
        baseY,
        arcPeak,
        carryDuration,
        carryLift,
        incomingVelocity = { x: 0, y: 0 },
    }) {
        this.ball = ball;
        this.startTime = startTime;
        this.endTime = endTime;
        this.catchX = catchX;
        this.releaseX = releaseX;
        this.landX = landX;
        this.baseY = baseY;
        this.arcPeak = arcPeak;
        this.carryDuration = carryDuration;
        this.carryLift = carryLift;
        // Velocity the ball actually had the instant it was caught here (from
        // whatever threw it - or {0, 0} if it just spawned into an idle hand).
        this.incomingVelocity = incomingVelocity;
    }

    get duration() {
        return this.endTime - this.startTime;
    }

    get flightDuration() {
        return this.duration - this.carryDuration;
    }

    /** Height the carry ends at, and the flight begins from. */
    get releaseY() {
        return this.baseY + this.carryLift;
    }

    /** Velocity (world units/sec) this throw launches the ball at. Derived
     * from the flight parabola itself, so the carry can be built to match it
     * exactly rather than guessing. */
    get launchVelocity() {
        const fd = this.flightDuration;
        if (fd <= 0) return { x: 0, y: 0 };
        return {
            x: (this.landX - this.releaseX) / fd,
            y: (this.baseY - this.releaseY + 4 * this.arcPeak) / fd,
        };
    }

    /** Velocity (world units/sec) the ball arrives at the end of this flight -
     * i.e. what the next carry should treat as its incoming velocity. */
    get landVelocity() {
        const fd = this.flightDuration;
        if (fd <= 0) return { x: 0, y: 0 };
        return {
            x: (this.landX - this.releaseX) / fd,
            y: (this.baseY - this.releaseY - 4 * this.arcPeak) / fd,
        };
    }

    positionAt(time) {
        const elapsed = Math.min(Math.max(time - this.startTime, 0), this.duration);

        if (elapsed <= this.carryDuration) {
            const p = this.carryDuration > 0 ? elapsed / this.carryDuration : 1;
            return this.carryPositionAt(p);
        }

        const fd = this.flightDuration;
        const p = fd > 0 ? (elapsed - this.carryDuration) / fd : 1;
        const x = this.releaseX + (this.landX - this.releaseX) * p;
        // Linear drift (release height -> catch height) plus a symmetric
        // "throw height" bump is still a single quadratic in p, i.e. still one
        // honest constant-gravity parabola - just not symmetric in time, same
        // as a real ball released from one height and caught at another.
        const y = this.releaseY + (this.baseY - this.releaseY) * p + this.arcPeak * 4 * p * (1 - p);
        return { x, y };
    }

    /**
     * Cubic Bezier from catch to release. A cubic has two control points -
     * just enough freedom to pin both endpoint tangents independently, so we
     * use them to match real velocities rather than pick an arbitrary shape:
     * the first leg leaves the catch point along incomingVelocity (however
     * the ball was actually falling when the hand caught it), and the second
     * leg arrives at the release point along launchVelocity (whatever the
     * outgoing flight requires). The recoil-then-scoop dip is therefore an
     * emergent result of real velocities, not a hand-tuned constant - a
     * higher incoming throw naturally recoils harder, a higher outgoing
     * throw naturally scoops more.
     */
    carryPositionAt(p) {
        const p0x = this.catchX, p0y = this.baseY;
        const p3x = this.releaseX, p3y = this.releaseY;
        const d = this.carryDuration / 3;
        let p1x = p0x + this.incomingVelocity.x * d;
        let p1y = p0y + this.incomingVelocity.y * d;
        const launch = this.launchVelocity;
        const p2x = p3x - launch.x * d;
        const p2y = p3y - launch.y * d;

        // Quick flat throws (e.g. a "1"): the catch-side and release-side
        // control points can end up far apart vertically, pinching a visible
        // kink at release even though velocity there is continuous - the
        // carry's end curvature just doesn't match the flight's. Easing p1
        // toward the release-side control softens that join; B'(1) is
        // unchanged, so the release tangent still matches launchVelocity.
        const flatness = 1 - Math.min(1, this.arcPeak / Math.max(this.carryLift, 1e-6));
        if (flatness > 0) {
            const pull = flatness * 0.58;
            p1x += (p2x - p1x) * pull;
            p1y += (p2y - p1y) * pull;
        }

        const q = 1 - p;
        const w0 = q * q * q;
        const w1 = 3 * q * q * p;
        const w2 = 3 * q * p * p;
        const w3 = p * p * p;
        return {
            x: w0 * p0x + w1 * p1x + w2 * p2x + w3 * p3x,
            y: w0 * p0y + w1 * p1y + w2 * p2y + w3 * p3y,
        };
    }

    /**
     * The full catch-to-catch path, for debug/trace rendering. Samples the
     * carry and flight phases with their own fixed point budgets rather than
     * splitting one budget proportionally by duration - otherwise a short
     * carry phase inside a long, high throw gets starved down to just a
     * couple of samples and reads as jagged straight segments instead of the
     * smooth curve it actually is.
     */
    samplePath({ carrySteps = 14, flightSteps = 24 } = {}) {
        const points = [];
        for (let i = 0; i <= carrySteps; i++) {
            points.push(this.positionAt(this.startTime + (i / carrySteps) * this.carryDuration));
        }
        const fd = this.flightDuration;
        for (let i = 1; i <= flightSteps; i++) {
            points.push(this.positionAt(this.startTime + this.carryDuration + (i / flightSteps) * fd));
        }
        return points;
    }
}
