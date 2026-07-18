// Soft, blurred, additively-blended color blobs drawn behind everything
// else (see drawBokeh) - a screensaver-like "bokeh" field, one blob per
// ball, that eases toward each ball's actual position rather than
// snapping to it, and grows/brightens with how fast that ball is currently
// moving on screen. Deliberately not tied to world-space ball radius or
// camera scale at all - unlike every other size in this file, bokeh blobs
// are meant to read as a diffuse background wash regardless of zoom, not
// as part of the simulated scene.
const BOKEH_BASE_RADIUS_RATIO = 0.5; // relative to min(cssWidth, cssHeight)
// Pulled back some from an earlier, even blurrier pass - at full screen
// coverage, too much blur was smearing every ball's color into the same
// indistinct mush; this keeps blobs soft while still letting distinct
// colors stay legible as they overlap.
const BOKEH_BLUR_PX = 90;
// Alpha pulled back from the smaller-blob version as the radius/blur above
// grew, since much bigger, heavily-overlapping circles under additive
// blending accumulate brightness fast - without this, filling the screen
// stops reading as a subdued wash and starts blowing out to solid color.
// Pulled back a further notch here so the effect stays subdued even once
// fully faded in (see `intensity` below).
const BOKEH_BASE_ALPHA = 0.042;
const BOKEH_SPEED_ALPHA_BOOST = 0.07;
const BOKEH_SPEED_RADIUS_BOOST = 0.35;
// Slow, gentle "breathing" of each blob's own radius, on top of (not
// instead of) its speed-driven size boost - a fixed sine wave over many
// seconds rather than anything tied to gameplay, purely to keep the field
// feeling alive even while balls are moving slowly or resting.
const BOKEH_PULSE_PERIOD_SECONDS = 9;
const BOKEH_PULSE_AMPLITUDE = 0.3; // fraction of the blob's own radius
// Each blob's pulse is offset by its ball id times this many radians
// rather than all starting in phase, so they visibly breathe out of sync
// with each other instead of swelling and shrinking in lockstep. The
// golden angle spreads any number of ids' phases evenly around the cycle
// rather than a plain fraction of 2*pi, which can land unlucky ids
// (e.g. exactly half the count apart) right back in phase with each other.
const BOKEH_PULSE_PHASE_STEP_RADIANS = 2.39996;
// Balls' actual screen-space horizontal range is only as wide as the
// juggling pattern itself, which sits well short of the screen's full
// width - most of a ball's real motion is fairly central. Multiplying a
// blob's horizontal offset from screen-center by this much lets the
// *color field* swing all the way out to both edges even though the balls
// producing it never do, rather than leaving the sides of the screen
// permanently bare. Vertical motion is left alone - throws already cover
// most of the screen's height on their own.
const BOKEH_HORIZONTAL_SPREAD_SCALE = 2.2;
// Radial-gradient inner stop, as a fraction of a blob's own (current)
// radius - within this innermost circle the color sits at full computed
// alpha; outside it, alpha eases down to 0 by the outer radius. Small on
// purpose: the fade needs to span nearly the whole blob, not just a thin
// band at its rim, for the blob to read as one smooth center-to-edge
// falloff rather than a solid disc with only its edge softened (which is
// closer to what blur alone, with no inner gradient stop at all, used to
// produce - see drawBokeh).
const BOKEH_INNER_RADIUS_RATIO = 0.08;
// Screen px/sec past which a blob's speed-driven size/brightness boost is
// already maxed out - tuned to roughly a fast throw's peak screen speed
// rather than any fixed world-space velocity, since this is measured in
// screen pixels (post camera-scale) already.
const BOKEH_SPEED_REFERENCE = 1400;
// How much of the gap to the ball's real position a blob closes per
// second (an exponential ease, not a fixed step) - small enough that the
// glow visibly lags and trails through a throw's arc instead of tracking
// it exactly, which is what makes it read as an ambient field the balls
// are stirring rather than a glow stuck to each ball.
const BOKEH_FOLLOW_TIME_CONSTANT = 0.5;
// Smooths the frame-to-frame instantaneous speed sample itself, since a
// single frame's raw delta (especially right at a throw/catch) is noisy.
const BOKEH_SPEED_SMOOTHING_SECONDS = 0.12;
const BOKEH_MAX_DT = 0.1; // Matches App/Game's own big-frame-gap clamp.

/** '#rrggbb' -> {r, g, b} - every ball color (see Ball.js's PALETTE) is already exactly this shape. */
function hexToRgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/**
 * Draws balls on a canvas. Owns the world->screen camera transform, so all
 * future zoom behavior (fit to ball count / max height) lives here without
 * touching the physics. World space has y up; screen space has y down.
 */
export default class Renderer {
    constructor(canvas, { background = '#12121f', padding = 0.12 } = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.background = background;
        this.padding = padding;

        this.cssWidth = 0;
        this.cssHeight = 0;
        this.camera = { scale: 1, centerX: 0, centerY: 0 };

        // Per-ball-id bokeh tracking state (see drawBokeh), keyed by the
        // `id` on each state.balls entry - persists across frames/draw()
        // calls so a blob's lag and speed-smoothing carry over smoothly,
        // rather than resetting every frame.
        this.bokehBlobs = new Map();
        this.lastBokehTime = null;
        // Free-running clock driving each blob's pulse (see drawBokeh) -
        // its own thing rather than reusing lastBokehTime directly so a
        // frame where drawBokeh no-ops early (no balls, reduced motion)
        // still leaves elapsed time consistent for whenever it resumes.
        this.bokehElapsedSeconds = 0;
        // Respect the OS-level motion preference - this effect is purely
        // decorative, so the simplest accessible behavior is just skipping
        // it entirely rather than offering a reduced variant.
        this.reducedMotion = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /** Match the backing store to the display size (accounting for DPR). */
    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.cssWidth = rect.width;
        this.cssHeight = rect.height;
        this.canvas.width = Math.round(rect.width * dpr);
        this.canvas.height = Math.round(rect.height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Fit the given world-space extent into the viewport, preserving aspect. */
    fit(extent) {
        const worldWidth = Math.max(extent.maxX - extent.minX, 1e-6);
        const worldHeight = Math.max(extent.maxY - extent.minY, 1e-6);
        const usableWidth = this.cssWidth * (1 - this.padding * 2);
        const usableHeight = this.cssHeight * (1 - this.padding * 2);
        this.camera = {
            scale: Math.min(usableWidth / worldWidth, usableHeight / worldHeight),
            centerX: (extent.minX + extent.maxX) / 2,
            centerY: (extent.minY + extent.maxY) / 2,
        };
        this.extent = extent;
    }

    /**
     * Screen position for a hand's throw-height wedge. Horizontally, the
     * wedge vertex (`cx`) sits halfway between that side of the screen and
     * the live juggling area's edge (see `jugglingBounds` from Game.draw -
     * *not* the padded camera-fit extent, which includes empty worst-case
     * queue margin and would shove wedges toward the bezel). Capped on
     * ultrawide layouts (see WEDGE_MAX_OFFSET_FROM_CENTER). Vertically,
     * nudged upward from the hand anchor.
     */
    wedgeScreenPosition(hand, handAnchor, jugglingBounds) {
        const WEDGE_OFFSET_Y = 80;
        if (!jugglingBounds) {
            const WEDGE_OFFSET_X = 110;
            return {
                cx: handAnchor.x + (hand === 'L' ? -WEDGE_OFFSET_X : WEDGE_OFFSET_X),
                cy: handAnchor.y - WEDGE_OFFSET_Y,
            };
        }

        const WEDGE_EDGE_INSET = 16;
        const WEDGE_MAX_OFFSET_FROM_CENTER = 500;

        const screenLeft = WEDGE_EDGE_INSET;
        const screenRight = this.cssWidth - WEDGE_EDGE_INSET;
        const centerX = this.cssWidth / 2;

        let cx;
        if (hand === 'L') {
            const ideal = (screenLeft + jugglingBounds.left) / 2;
            cx = Math.max(ideal, centerX - WEDGE_MAX_OFFSET_FROM_CENTER);
        } else {
            const ideal = (jugglingBounds.right + screenRight) / 2;
            cx = Math.min(ideal, centerX + WEDGE_MAX_OFFSET_FROM_CENTER);
        }

        return { cx, cy: handAnchor.y - WEDGE_OFFSET_Y };
    }

    worldToScreen(x, y) {
        const { scale, centerX, centerY } = this.camera;
        return {
            x: this.cssWidth / 2 + (x - centerX) * scale,
            y: this.cssHeight / 2 - (y - centerY) * scale,
        };
    }

    /**
     * A soft, colored "bokeh" wash behind everything else: one big blurred,
     * additively-blended circle per ball (see BOKEH_* above), sized and
     * brightened by how fast that ball is currently moving on screen, and
     * further breathing slowly in and out on its own fixed cycle (each
     * blob's own phase offset by its ball id - see BOKEH_PULSE_*), whose
     * position eases toward the ball's real one rather than snapping to it -
     * so the field reads as an ambient, slowly-shifting glow the balls stir
     * as they move, not a halo glued to each one. Every ball currently in
     * `balls` (flying, held, or waiting in a queue) gets a blob, all of
     * them always present at once - a resting/queued ball's blob just
     * settles down to near-zero size/alpha on its own once its speed
     * (tracked per id, see bokehBlobs) decays, rather than being added or
     * removed as balls start/stop flying.
     *
     * No-ops entirely (and drops all tracked state) once `balls` is empty -
     * e.g. the title screen, or right after Stop - so a later demo/game
     * restarting with fresh, lower ball ids never inherits a stale blob
     * position left over from a previous run.
     *
     * `intensity` (0-1, defaulting to fully on) is an overall alpha
     * multiplier - Game/App ramp this up from 0 as the player (or the
     * scripted demo) racks up a clean run, so the whole effect fades in
     * gradually rather than being either fully present or fully absent
     * (see Soundtrack.getVisualProgress, which both derive it from so this
     * lands "fully on" at the exact same moment the soundtrack's own echo
     * voice kicks in).
     */
    drawBokeh(balls, intensity = 1) {
        const now = performance.now();
        const dt = this.lastBokehTime != null
            ? Math.min((now - this.lastBokehTime) / 1000, BOKEH_MAX_DT)
            : 0;
        this.lastBokehTime = now;
        this.bokehElapsedSeconds += dt;

        if (this.reducedMotion || !balls || balls.length === 0 || intensity <= 0) {
            this.bokehBlobs.clear();
            return;
        }

        const ctx = this.ctx;
        const baseRadius = Math.min(this.cssWidth, this.cssHeight) * BOKEH_BASE_RADIUS_RATIO;
        const followRate = 1 - Math.exp(-dt / BOKEH_FOLLOW_TIME_CONSTANT);
        const speedSmoothingRate = dt > 0 ? Math.min(1, dt / BOKEH_SPEED_SMOOTHING_SECONDS) : 0;
        const centerX = this.cssWidth / 2;

        ctx.save();
        ctx.filter = `blur(${BOKEH_BLUR_PX}px)`;
        ctx.globalCompositeOperation = 'lighter';

        const seenIds = new Set();
        for (const ball of balls) {
            if (ball.id == null) continue;
            seenIds.add(ball.id);
            const screen = this.worldToScreen(ball.x, ball.y);
            // The blob's own target position, not the ball's real screen
            // position - see BOKEH_HORIZONTAL_SPREAD_SCALE above.
            const targetX = centerX + (screen.x - centerX) * BOKEH_HORIZONTAL_SPREAD_SCALE;
            const targetY = screen.y;

            let blob = this.bokehBlobs.get(ball.id);
            if (!blob) {
                blob = {
                    x: targetX, y: targetY, prevX: targetX, prevY: targetY, speed: 0,
                    pulsePhase: ball.id * BOKEH_PULSE_PHASE_STEP_RADIANS,
                };
                this.bokehBlobs.set(ball.id, blob);
            }

            if (dt > 0) {
                const instantSpeed = Math.hypot(targetX - blob.prevX, targetY - blob.prevY) / dt;
                blob.speed += (instantSpeed - blob.speed) * speedSmoothingRate;
            }
            blob.prevX = targetX;
            blob.prevY = targetY;
            blob.x += (targetX - blob.x) * followRate;
            blob.y += (targetY - blob.y) * followRate;

            const speedRatio = Math.min(blob.speed / BOKEH_SPEED_REFERENCE, 1);
            const pulseAngle = (this.bokehElapsedSeconds / BOKEH_PULSE_PERIOD_SECONDS) * Math.PI * 2 + blob.pulsePhase;
            const pulse = 1 + Math.sin(pulseAngle) * BOKEH_PULSE_AMPLITUDE;
            const radius = baseRadius * (1 + speedRatio * BOKEH_SPEED_RADIUS_BOOST) * pulse;
            const alpha = (BOKEH_BASE_ALPHA + speedRatio * BOKEH_SPEED_ALPHA_BOOST) * intensity;

            // A radial gradient rather than a flat fill so the fade spans
            // nearly the whole blob (see BOKEH_INNER_RADIUS_RATIO) instead
            // of relying on the canvas blur filter alone to soften just its
            // outer rim.
            const { r, g, b } = hexToRgb(ball.color);
            const gradient = ctx.createRadialGradient(
                blob.x, blob.y, radius * BOKEH_INNER_RADIUS_RATIO,
                blob.x, blob.y, radius,
            );
            gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
            gradient.addColorStop(0.3, `rgba(${r}, ${g}, ${b}, ${alpha})`);
            gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

            ctx.beginPath();
            ctx.arc(blob.x, blob.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = gradient;
            ctx.fill();
        }

        // Ball ids are stable and always all-present for a pattern's whole
        // life (see Game/JugglingSimulator's own render-state builders), so
        // this only actually trims anything when a new, shorter-lived
        // pattern starts - guards against stale blobs outliving the ball
        // id they belonged to.
        for (const id of this.bokehBlobs.keys()) {
            if (!seenIds.has(id)) this.bokehBlobs.delete(id);
        }

        ctx.restore();
    }

    draw(state) {
        const ctx = this.ctx;
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

        // Drawn immediately after the flat background fill, before
        // anything else - a background layer the rest of the scene sits on
        // top of, not a glow added on top of it (see drawBokeh).
        this.drawBokeh(state.balls, state.bokehIntensity);

        // Trails are drawn before the balls so they read as a fading tail
        // behind each one, not a preview of where it's about to go. Each
        // recorded point gets its own dot rather than being connected into a
        // dashed stroke - a dashed line needs a phase anchored to "distance
        // from the trail's oldest surviving point," but that point keeps
        // advancing forward as older ones age out, so the dashes would
        // visibly crawl along the path every frame. A dot only ever sits at
        // the one fixed world position it was recorded at, so it can't slide.
        const dotRadius = Math.min(1.5, (state.ballRadius ?? 0.12) * this.camera.scale * 0.3);

        if (state.trails) {
            ctx.save();
            for (const trail of state.trails) {
                if (trail.length < 2) continue;
                const oldestTime = trail[0].time;
                const span = Math.max(trail[trail.length - 1].time - oldestTime, 1e-6);

                for (let i = 0; i < trail.length; i++) {
                    const point = trail[i];
                    const age = (point.time - oldestTime) / span;
                    const screen = this.worldToScreen(point.x, point.y);
                    ctx.beginPath();
                    ctx.arc(screen.x, screen.y, dotRadius, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(255, 255, 255, ${(age * 0.85).toFixed(3)})`;
                    ctx.fill();
                }
            }
            ctx.restore();
        }

        // The static "ghost" of every throw the pattern should make, all
        // rendered at once and at a fixed opacity (no fade - there's no
        // "recency" to fade by, since nothing is actually moving here).
        // Each entry is either a plain array of points, or a
        // { points, highlighted } wrapper - used e.g. to pick out "whichever
        // throw happens this beat" as a practice-mode cue - drawn brighter
        // than the rest.
        if (state.staticPaths) {
            ctx.save();
            ctx.lineWidth = Math.min(1.5, (state.ballRadius ?? 0.12) * this.camera.scale * 0.3);
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            const strokePath = (points) => {
                ctx.beginPath();
                const first = this.worldToScreen(points[0].x, points[0].y);
                ctx.moveTo(first.x, first.y);
                for (let i = 1; i < points.length; i++) {
                    const screen = this.worldToScreen(points[i].x, points[i].y);
                    ctx.lineTo(screen.x, screen.y);
                }
                ctx.stroke();
            };
            // Two passes so a highlighted path always draws on top of the
            // rest, regardless of where it falls in the array - otherwise
            // an earlier, dimmer path drawn after it could visually cut into
            // its highlight where the two cross.
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            for (const entry of state.staticPaths) {
                const points = Array.isArray(entry) ? entry : entry.points;
                if (points.length >= 2 && !entry.highlighted) strokePath(points);
            }
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
            for (const entry of state.staticPaths) {
                const points = Array.isArray(entry) ? entry : entry.points;
                if (points.length >= 2 && entry.highlighted) strokePath(points);
            }
            ctx.restore();
        }

        for (const ball of state.balls) {
            const screen = this.worldToScreen(ball.x, ball.y);
            const radius = ball.radius * this.camera.scale;
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = ball.color;
            ctx.fill();
        }

        if (state.wedges) {
            for (const wedge of state.wedges) {
                this.drawThrowHeightWedge(wedge, state.jugglingBounds);
            }
        }
    }

    /**
     * The throw-height selector, always visible for both hands: a
     * quarter-circle fan opening straight up, anchored in screen space
     * just outside and above each hand (see drawThrowHeightWedge), split by
     * a vertical line into a crossing half and a self half, each further divided into concentric rings - one per
     * available height, closest-to-vertex first - labeled with that
     * height's number. Whichever half matches the button being held lights
     * height's number. White while charging (release inside the charge window
     * to lock, or hold through the beat if the window hasn't expired), yellow
     * after release (locked until the beat), then a brief green or red flash
     * when the beat lands. Fully unlit whenever nothing is charging/locked/
     * flashing, rather than disappearing, so the player can watch it ahead
     * of a press (see Game.buildWedgeState).
     *
     * Ring numbers normally rely on vanilla's odd-means-crossing convention
     * to tell the two sides apart at a glance. Sync notation has no such
     * link (every height is even on both sides - see
     * ThrowHeight.getAvailableHeights), so when `sync` is set the cross
     * side's labels get an explicit trailing 'x' instead (e.g. "4x"),
     * matching sync notation itself.
     *
     * The small circle sitting in the vertex gap below the innermost ring is
     * the target indicator (`target`): a dotted outline if this hand has no
     * ball and none will land in time, or a circle filled/outlined in that
     * ball's color once there's one to throw - letting the player judge
     * whether (and which ball) pressing now would actually launch, which
     * matters most for a ball that's still mid-flight toward this hand.
     * "LEFT HAND" / "RIGHT HAND" labels sit just above the outermost ring.
     *
     * Sized in fixed screen pixels rather than world units, on purpose -
     * like the beat bar, this is HUD, not part of the simulated scene.
     * Horizontal placement is derived from the live juggling bounds passed
     * in each frame (see Game.computeJugglingScreenBounds) so each wedge
     * vertex sits halfway between the screen edge and where balls/paths
     * actually are - not the padded camera-fit extent.
     * ring geometry itself stays a constant pixel size regardless of zoom.
     */
    drawThrowHeightWedge({ hand, anchor, crossHeights, selfHeights, sync, activeSide, litRings, cancelFlash, locked, beatFlash, target }, jugglingBounds) {
        const ctx = this.ctx;
        const { cx, cy } = this.wedgeScreenPosition(hand, anchor, jugglingBounds);

        const innerRadius = 28;
        // Smaller than innerRadius so the target indicator sits entirely
        // within the vertex gap, never touching the innermost ring.
        const targetRadius = innerRadius - 6;
        const ringThickness = 40;
        const ringCount = Math.max(crossHeights.length, selfHeights.length);
        const outerRadius = innerRadius + ringCount * ringThickness;
        const halfAngle = Math.PI / 4; // 45 degrees either side of vertical.
        const upAngle = -Math.PI / 2; // Canvas angle for "straight up" from the anchor.
        const leftAngle = upAngle - halfAngle;
        const rightAngle = upAngle + halfAngle;

        const angleRanges = hand === 'L'
            ? { cross: [upAngle, rightAngle], self: [leftAngle, upAngle] }
            : { cross: [leftAngle, upAngle], self: [upAngle, rightAngle] };

        const flashColors = {
            green: { fill: 'rgba(60, 190, 80, 0.92)', stroke: 'rgba(160, 255, 170, 0.95)', text: '#111' },
            red: { fill: 'rgba(210, 50, 50, 0.92)', stroke: 'rgba(255, 120, 120, 0.95)', text: '#fff' },
        };
        const flashStyle = beatFlash ? flashColors[beatFlash] : null;

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = flashStyle?.stroke ?? (cancelFlash ? 'rgba(255, 120, 120, 0.95)' : 'rgba(255, 255, 255, 0.9)');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '16px "Asimovian", monospace';

        for (const side of ['cross', 'self']) {
            const heights = side === 'cross' ? crossHeights : selfHeights;
            const [startAngle, endAngle] = angleRanges[side];
            const isActiveSide = activeSide === side;

            for (let ring = 0; ring < heights.length; ring++) {
                const r0 = innerRadius + ring * ringThickness;
                const r1 = r0 + ringThickness;
                const lit = !cancelFlash && isActiveSide && ring < litRings;

                ctx.beginPath();
                ctx.arc(cx, cy, r1, startAngle, endAngle);
                ctx.arc(cx, cy, r0, endAngle, startAngle, true);
                ctx.closePath();

                let fillStyle = null;
                if (flashStyle) {
                    if (lit) fillStyle = flashStyle.fill;
                } else if (cancelFlash) {
                    fillStyle = 'rgba(210, 50, 50, 0.92)';
                } else if (lit && locked) {
                    fillStyle = `rgba(240, 210, 50, ${Math.max(0.45, 1 - ring * 0.15).toFixed(3)})`;
                } else if (lit) {
                    fillStyle = `rgba(255, 255, 255, ${Math.max(0.4, 1 - ring * 0.15).toFixed(3)})`;
                }
                // Unlit rings leave fillStyle null so only the stroke shows -
                // same effect as a transparent/page-colored background rather
                // than the old semi-opaque dark overlay.

                if (fillStyle) {
                    ctx.fillStyle = fillStyle;
                    ctx.fill();
                }
                ctx.stroke();

                const midAngle = (startAngle + endAngle) / 2;
                const midR = (r0 + r1) / 2;
                if (flashStyle) {
                    ctx.fillStyle = lit ? flashStyle.text : '#fff';
                } else if (cancelFlash) {
                    ctx.fillStyle = '#fff';
                } else if (lit) {
                    ctx.fillStyle = locked ? '#111' : '#111';
                } else {
                    ctx.fillStyle = '#fff';
                }
                const label = sync && side === 'cross' ? `${heights[ring]}x` : String(heights[ring]);
                ctx.fillText(
                    label,
                    cx + Math.cos(midAngle) * midR,
                    cy + Math.sin(midAngle) * midR,
                );
            }
        }

        ctx.font = '700 16px "Turret Road", sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
            hand === 'L' ? 'LEFT HAND' : 'RIGHT HAND',
            cx,
            cy - outerRadius - 10,
        );

        if (target) {
            const TARGET_FILL_ALPHA = 0.32;
            const TARGET_STROKE_ALPHA = 0.55;
            const TARGET_EMPTY_ALPHA = 0.5;

            ctx.beginPath();
            ctx.arc(cx, cy, targetRadius, 0, Math.PI * 2);
            if (target.valid) {
                ctx.globalAlpha = TARGET_FILL_ALPHA;
                ctx.fillStyle = target.color;
                ctx.fill();
                ctx.globalAlpha = TARGET_STROKE_ALPHA;
                ctx.lineWidth = 2;
                ctx.strokeStyle = target.color;
                ctx.stroke();
                ctx.globalAlpha = 1;
            } else {
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = `rgba(255, 255, 255, ${TARGET_EMPTY_ALPHA})`;
                ctx.stroke();
            }
        }

        ctx.restore();
    }
}
