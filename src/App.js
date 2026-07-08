import Siteswap from './Siteswap.js';
import JugglingSimulator from './JugglingSimulator.js';
import Renderer from './Renderer.js';

const BPM = 200;
const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

export default class App {
    constructor() {
        this.$input = $('#siteswap-input');
        this.$button = $('#juggle-button');
        this.$message = $('#validation-message');
        this.canvas = document.getElementById('juggle-canvas');

        this.renderer = new Renderer(this.canvas);
        this.siteswap = null;
        this.simulator = null;
        this.rafId = null;
        this.lastTimestamp = 0;

        this.bindEvents();
        this.handleResize();
        this.validate();
    }

    bindEvents() {
        this.$input.on('input', () => this.validate());
        this.$button.on('click', () => {
            if (this.simulator) {
                this.stop();
            } else {
                this.startJuggling();
            }
        });
        $(window).on('resize', () => this.handleResize());
    }

    handleResize() {
        this.renderer.resize();
        if (this.simulator) {
            this.renderer.fit(this.simulator.getExtent());
            this.renderer.draw(this.simulator.getRenderState());
        } else {
            this.renderer.draw({ balls: [] });
        }
    }

    validate() {
        // Editing the pattern always stops any running animation; the player
        // must press Juggle! again to watch the (possibly new) pattern.
        this.stop();

        const raw = this.$input.val();
        this.siteswap = Siteswap.parse(raw);

        if (this.siteswap.isValid) {
            const { numBalls, period } = this.siteswap;
            const plural = numBalls === 1 ? '' : 's';
            this.$message
                .text(`Valid: ${numBalls} ball${plural}, period ${period}`)
                .attr('class', 'valid');
            this.$button.prop('disabled', false);
        } else {
            const isEmpty = raw.trim() === '';
            this.$message
                .text(this.siteswap.error)
                .attr('class', isEmpty ? '' : 'invalid');
            this.$button.prop('disabled', true);
        }
    }

    startJuggling() {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.stop();

        this.simulator = new JugglingSimulator(this.siteswap, { bpm: BPM });
        this.renderer.fit(this.simulator.getExtent());
        this.lastTimestamp = performance.now();
        this.rafId = requestAnimationFrame((ts) => this.tick(ts));

        this.$button.text('Stop').addClass('playing');
    }

    tick(timestamp) {
        const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
        this.lastTimestamp = timestamp;

        this.simulator.update(dt);
        this.renderer.draw(this.simulator.getRenderState());

        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    stop() {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.simulator = null;
        this.renderer.draw({ balls: [] });
        this.$button.text('Juggle!').removeClass('playing');
    }
}
