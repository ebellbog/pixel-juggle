import Siteswap from './Siteswap.js';
import SyncSiteswap from './SyncSiteswap.js';
import JugglingSimulator from './JugglingSimulator.js';
import Renderer from './Renderer.js';
import Game from './Game.js';

const DEFAULT_BPM = 60;
const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

/**
 * Owns the page's idle-state chrome - siteswap input/validation, the action
 * buttons, and the BPM slider - plus the "Show me" demo. Everything that
 * happens after "Let me try!" is instead Game's job (see there).
 */
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
        // Only set while "Let me try!" gameplay mode is active.
        this.game = null;
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
        this.$tryButton.on('click', () => this.startGame());
        this.$stopButton.on('click', () => this.stop());
        this.$bpmSlider.on('input', () => this.setBpm(Number(this.$bpmSlider.val())));
        $(window).on('resize', () => this.handleResize());
    }

    setBpm(bpm) {
        this.bpm = bpm;
        this.$bpmValue.text(bpm);
        // Live speed change: an already-running demo/game keeps going, just
        // faster or slower from here, rather than restarting from scratch.
        if (this.simulator) {
            this.simulator.setBpm(bpm);
            this.renderer.fit(this.simulator.getExtent());
        }
        if (this.game) {
            this.game.setBpm(bpm);
        }
    }

    handleResize() {
        this.renderer.resize();
        if (this.simulator) {
            this.renderer.fit(this.simulator.getExtent());
            this.renderer.draw(this.simulator.getRenderState());
        } else if (this.game) {
            this.game.handleResize();
        } else {
            this.renderer.draw({ balls: [] });
        }
    }

    validate() {
        // Editing the pattern always stops any running demo/game; the
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

    /** "Let me try!" - hands off to Game for everything from here on. */
    startGame() {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.stop();

        this.game = new Game(this.siteswap, {
            bpm: this.bpm,
            renderer: this.renderer,
            $beatBar: this.$beatBar,
            $beatBarWrap: this.$beatBarWrap,
        });
        this.game.start();

        this.showStopButton();
    }

    stop() {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.simulator = null;
        if (this.game) {
            this.game.stop();
            this.game = null;
        }
        this.renderer.draw({ balls: [] });
        this.showActionButtons();
    }
}
