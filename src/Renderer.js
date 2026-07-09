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
                    ctx.arc(screen.x, screen.y, 1.5, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(255, 255, 255, ${(age * 0.85).toFixed(3)})`;
                    ctx.fill();
                }
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
    }
}
