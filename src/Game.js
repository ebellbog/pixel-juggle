import JugglingSimulator from './JugglingSimulator.js';

const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

/**
 * Everything that happens once the player commits to "Let me try!" - for now
 * just the static ghost-path preview and its beat cue, but this is where
 * future player-interaction logic (real throw input, scoring, catches/misses)
 * will live too, so it's kept separate from App's job of managing the
 * page's idle-state chrome (siteswap input, action buttons, BPM slider).
 *
 * Owns its own animation loop and beat clock rather than sharing App's -
 * App only ever runs one of "Show me" or "Let me try!" at a time anyway
 * (see App.stop), so there's no real coupling lost by each managing its own
 * requestAnimationFrame.
 */
export default class Game {
    constructor(siteswap, { bpm, renderer, $beatBar, $beatBarWrap }) {
        this.renderer = renderer;
        this.$beatBar = $beatBar;
        this.$beatBarWrap = $beatBarWrap;
        this.bpm = bpm;

        // A throwaway simulator purely to compute static geometry - it's
        // never ticked with update(), so none of its time/tempo behavior
        // comes into play, only the pattern's fixed shape (see
        // JugglingSimulator.getGhostPaths).
        const ghost = new JugglingSimulator(siteswap, { bpm });
        this.paths = ghost.getGhostPaths();
        this.extent = ghost.getExtent();
        this.ballRadius = ghost.ballRadius;
        this.period = ghost.period;

        // Beat bar and ghost-path highlight are driven off this one clock,
        // so dragging the BPM slider can't leave them out of sync with each
        // other (see draw/tick).
        this.beatIndex = 0;
        this.beatElapsed = 0;

        this.rafId = null;
        this.lastTimestamp = 0;
    }

    start() {
        this.renderer.fit(this.extent);
        this.$beatBar.css('transform', 'scaleX(1)');
        this.$beatBarWrap.removeClass('hidden');

        this.lastTimestamp = performance.now();
        this.draw();
        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    setBpm(bpm) {
        this.bpm = bpm;
    }

    /**
     * Advances which ghost path is highlighted - "the throw due this beat" -
     * in step with the beat bar's own countdown.
     */
    tick(timestamp) {
        const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
        this.lastTimestamp = timestamp;

        const beatDuration = 60 / this.bpm;
        this.beatElapsed += dt;
        while (this.beatElapsed >= beatDuration) {
            this.beatElapsed -= beatDuration;
            this.beatIndex = (this.beatIndex + 1) % this.period;
        }
        this.draw();

        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    draw() {
        const beatDuration = 60 / this.bpm;
        const beatProgress = Math.min(this.beatElapsed / beatDuration, 1);
        this.$beatBar.css('transform', `scaleX(${1 - beatProgress})`);

        this.renderer.draw({
            balls: [],
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
        this.$beatBarWrap.addClass('hidden');
    }
}
