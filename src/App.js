import Siteswap from './Siteswap.js';
import SyncSiteswap from './SyncSiteswap.js';
import JugglingSimulator from './JugglingSimulator.js';
import Renderer from './Renderer.js';

const DEFAULT_BPM = 100;
const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

export default class App {
    constructor() {
        this.$input = $('#siteswap-input');
        this.$showMeButton = $('#show-me-button');
        this.$tryButton = $('#try-button');
        this.$stopButton = $('#stop-button');
        this.$message = $('#validation-message');
        this.$bpmSlider = $('#bpm-slider');
        this.$bpmValue = $('#bpm-value');
        this.$beatBarWrap = $('#beat-bar-wrap');
        this.$beatBar = $('#beat-bar');
        this.canvas = document.getElementById('juggle-canvas');

        this.renderer = new Renderer(this.canvas);
        this.siteswap = null;
        // Only set while the "Show me" demo animation is actually running.
        this.simulator = null;
        // Static geometry for "Let me try!" preview mode - recomputed once
        // per startPreview() call, then just redrawn as-is (e.g. on resize).
        this.previewPaths = null;
        this.previewExtent = null;
        this.previewBallRadius = null;
        this.rafId = null;
        this.lastTimestamp = 0;
        this.bpm = Number(this.$bpmSlider.val()) || DEFAULT_BPM;

        this.bindEvents();
        this.handleResize();
        this.validate();
    }

    bindEvents() {
        this.$input.on('input', () => this.validate());
        this.$input.on('keydown', (event) => {
            if (event.key === 'Enter' && this.siteswap && this.siteswap.isValid) {
                event.preventDefault();
                this.startDemo();
            }
        });
        this.$showMeButton.on('click', () => this.startDemo());
        this.$tryButton.on('click', () => this.startPreview());
        this.$stopButton.on('click', () => this.stop());
        this.$bpmSlider.on('input', () => this.setBpm(Number(this.$bpmSlider.val())));
        $(window).on('resize', () => this.handleResize());
    }

    setBpm(bpm) {
        this.bpm = bpm;
        this.$bpmValue.text(bpm);
        // Live speed change: an already-running demo keeps going, just
        // faster or slower from here, rather than restarting from scratch.
        if (this.simulator) {
            this.simulator.setBpm(bpm);
            this.renderer.fit(this.simulator.getExtent());
        }
        if (this.previewPaths) {
            this.updateBeatBarTempo();
        }
    }

    handleResize() {
        this.renderer.resize();
        if (this.simulator) {
            this.renderer.fit(this.simulator.getExtent());
            this.renderer.draw(this.simulator.getRenderState());
        } else if (this.previewPaths) {
            this.renderer.fit(this.previewExtent);
            this.drawPreview();
        } else {
            this.renderer.draw({ balls: [] });
        }
    }

    validate() {
        // Editing the pattern always stops any running demo/preview; the
        // player must choose an action again to watch (or practice) the
        // (possibly new) pattern.
        this.stop();

        const raw = this.$input.val();
        this.siteswap = SyncSiteswap.looksLikeSync(raw) ? SyncSiteswap.parse(raw) : Siteswap.parse(raw);

        if (this.siteswap.isValid) {
            const { numBalls, period } = this.siteswap;
            const plural = numBalls === 1 ? '' : 's';
            this.$message
                .text(`Valid: ${numBalls} ball${plural}, period ${period}`)
                .attr('class', 'valid');
            this.$showMeButton.prop('disabled', false);
            this.$tryButton.prop('disabled', false);
        } else {
            const isEmpty = raw.trim() === '';
            this.$message
                .text(this.siteswap.error)
                .attr('class', isEmpty ? '' : 'invalid');
            this.$showMeButton.prop('disabled', true);
            this.$tryButton.prop('disabled', true);
        }
    }

    /** Swaps the two idle-state action buttons for the single Stop button. */
    showStopButton() {
        this.$showMeButton.addClass('hidden');
        this.$tryButton.addClass('hidden');
        this.$stopButton.removeClass('hidden');
    }

    showActionButtons() {
        this.$stopButton.addClass('hidden');
        this.$showMeButton.removeClass('hidden');
        this.$tryButton.removeClass('hidden');
    }

    /** "Show me" - the fully automatic demo animation (previous behavior). */
    startDemo() {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.stop();

        this.simulator = new JugglingSimulator(this.siteswap, { bpm: this.bpm });
        this.renderer.fit(this.simulator.getExtent());
        this.lastTimestamp = performance.now();
        this.rafId = requestAnimationFrame((ts) => this.tick(ts));

        this.showStopButton();
    }

    tick(timestamp) {
        const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
        this.lastTimestamp = timestamp;

        this.simulator.update(dt);
        this.renderer.draw(this.simulator.getRenderState());

        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    /**
     * "Let me try!" - the first step into gameplay mode. Not interactive
     * yet: for now this just shows the beat metronome plus a static "ghost"
     * of every throw the pattern should make, so the player has a fixed
     * reference to practice against before we wire up real input.
     */
    startPreview() {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.stop();

        // A throwaway simulator purely to compute static geometry - it's
        // never ticked with update(), so none of its time/tempo behavior
        // comes into play, only the pattern's fixed shape (see
        // JugglingSimulator.getGhostPaths).
        const ghost = new JugglingSimulator(this.siteswap, { bpm: this.bpm });
        this.previewPaths = ghost.getGhostPaths();
        this.previewExtent = ghost.getExtent();
        this.previewBallRadius = ghost.ballRadius;

        this.renderer.fit(this.previewExtent);
        this.drawPreview();

        this.showStopButton();
        this.startBeatBar();
    }

    drawPreview() {
        this.renderer.draw({
            balls: [],
            staticPaths: this.previewPaths,
            ballRadius: this.previewBallRadius,
        });
    }

    startBeatBar() {
        this.updateBeatBarTempo();
        // Un-hiding is also what restarts the animation from its beginning:
        // a display:none element's CSS animation resets to its 0% keyframe,
        // and stop() always hides this before any new start (see there).
        this.$beatBarWrap.removeClass('hidden');
    }

    updateBeatBarTempo() {
        this.$beatBar.css('animation-duration', `${60 / this.bpm}s`);
    }

    stop() {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.simulator = null;
        this.previewPaths = null;
        this.previewExtent = null;
        this.previewBallRadius = null;
        this.$beatBarWrap.addClass('hidden');
        this.renderer.draw({ balls: [] });
        this.showActionButtons();
    }
}
