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

    draw(state) {
        const ctx = this.ctx;
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

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
        ctx.font = '16px sans-serif';

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

                if (flashStyle) {
                    ctx.fillStyle = lit ? flashStyle.fill : 'rgba(0, 0, 0, 0.35)';
                } else if (cancelFlash) {
                    ctx.fillStyle = 'rgba(210, 50, 50, 0.92)';
                } else if (lit && locked) {
                    ctx.fillStyle = `rgba(240, 210, 50, ${Math.max(0.45, 1 - ring * 0.15).toFixed(3)})`;
                } else if (lit) {
                    ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0.4, 1 - ring * 0.15).toFixed(3)})`;
                } else {
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
                }
                ctx.fill();
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

        ctx.font = '14px sans-serif';
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
