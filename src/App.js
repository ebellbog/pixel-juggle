import Siteswap from './Siteswap.js';
import SyncSiteswap from './SyncSiteswap.js';
import JugglingSimulator from './JugglingSimulator.js';
import Renderer from './Renderer.js';
import Game from './Game.js';
import Soundtrack from './Soundtrack.js';
import { PATTERN_GROUPS, CUSTOM_PATTERN_VALUE, patternShowsSiteswap, findPattern } from './patterns.js';

const DEFAULT_BPM = 60;
const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

/**
 * Owns the page's three screens - the title/menu screen (siteswap picker,
 * Show me/Let me try), the "Show me" demo, and Game's "Let me try!"
 * gameplay - plus which one is currently showing. Exactly one body class
 * (mode-menu / mode-demo / mode-game, see setMode) selects between them in
 * index.less; App itself never toggles an individual element's visibility.
 * Everything that happens once "Let me try!" is running is instead Game's
 * job (see there).
 */
export default class App {
    constructor() {
        this.$body = $(document.body);
        this.$patternSelectWrap = $('#pattern-select-wrap');
        this.$patternSelectTrigger = $('#pattern-select-trigger');
        this.$patternSelectList = $('#pattern-select-list');
        this.$customInputWrap = $('#custom-input-wrap');
        this.$input = $('#siteswap-input');
        this.$showMeButton = $('#show-me-button');
        this.$tryButton = $('#try-button');
        this.$stopButton = $('#stop-button');
        this.$restartButton = $('#restart-button');
        this.$muteButton = $('#mute-button');
        this.$validationIcon = $('#validation-icon');
        this.$bpmSlider = $('#bpm-slider');
        this.$bpmValue = $('#bpm-value');
        this.$beatBarWrap = $('#beat-bar-wrap');
        this.$beatBar = $('#beat-bar');
        this.canvas = document.getElementById('juggle-canvas');

        this.renderer = new Renderer(this.canvas);
        // Shared for the whole page's life - both the demo's JugglingSimulator
        // and Game get the same instance (see startDemo/startGame), so a mute
        // toggled mid-demo stays muted if the player then switches to "Let me
        // try!" without needing to reconcile two separate mute states.
        this.soundtrack = new Soundtrack();
        this.siteswap = null;
        // Only set while the "Show me" demo animation is actually running.
        this.simulator = null;
        // Only set while "Let me try!" gameplay mode is active.
        this.game = null;
        this.rafId = null;
        this.lastTimestamp = 0;
        this.bpm = Number(this.$bpmSlider.val()) || DEFAULT_BPM;
        this.patternValue = PATTERN_GROUPS[0].patterns[0].value;

        this.buildPatternSelect();
        this.bindEvents();
        this.setMode('menu');
        this.handleResize();
        this.setPatternValue(this.patternValue);
        this.updateMuteButton();
    }

    buildPatternSelect() {
        const $list = this.$patternSelectList.empty();

        PATTERN_GROUPS.forEach((group, groupIndex) => {
            if (groupIndex > 0) {
                $list.append($('<li>', { class: 'pattern-select-divider', role: 'presentation' }));
            }

            $list.append($('<li>', {
                class: 'pattern-select-group-label',
                text: group.label,
            }));

            for (const pattern of group.patterns) {
                $list.append(this.createPatternOption(pattern.value, pattern.name));
            }
        });

        $list.append($('<li>', { class: 'pattern-select-divider pattern-select-divider-major', role: 'presentation' }));
        $list.append(this.createPatternOption(CUSTOM_PATTERN_VALUE, 'Custom\u2026'));
    }

    createPatternOption(value, name) {
        const $siteswap = $('<span>', { class: 'pattern-siteswap' });
        if (value !== CUSTOM_PATTERN_VALUE && patternShowsSiteswap(name, value)) {
            $siteswap.text(value);
        } else {
            $siteswap.addClass('hidden');
        }

        const classes = ['pattern-select-option'];
        if (value === CUSTOM_PATTERN_VALUE) classes.push('pattern-select-custom');

        return $('<li>', {
            class: classes.join(' '),
            role: 'option',
            'data-value': value,
        }).append(
            $('<span>', { class: 'pattern-name', text: name }),
            $siteswap,
        );
    }

    /** Closed trigger shows the pattern name only - siteswap suffixes stay in the list. */
    renderPatternTrigger(name) {
        this.$patternSelectTrigger.find('.pattern-name').text(name);
    }

    setPatternListOpen(open) {
        this.$patternSelectList.toggleClass('hidden', !open);
        this.$patternSelectWrap.toggleClass('open', open);
        this.$patternSelectTrigger.attr('aria-expanded', open ? 'true' : 'false');

        // Otherwise, reopening after scrolling down to a lower option leaves
        // the list scrolled to that spot, which can push the top options
        // out of view (and out of easy reach) until the user scrolls back up.
        if (open) {
            const selected = this.$patternSelectList.find('.pattern-select-option.selected')[0];
            (selected || this.$patternSelectList[0]).scrollIntoView({ block: 'nearest' });
        }
    }

    setPatternValue(value) {
        this.patternValue = value;
        this.$patternSelectList.find('.pattern-select-option').removeClass('selected');

        if (value === CUSTOM_PATTERN_VALUE) {
            this.renderPatternTrigger('Custom\u2026');
            this.$customInputWrap.removeClass('hidden');
            this.$input.trigger('focus');
        } else {
            const pattern = findPattern(value);
            this.renderPatternTrigger(pattern.name);
            this.$customInputWrap.addClass('hidden');
            this.$input.val(value);
            this.$patternSelectList
                .find('.pattern-select-option')
                .filter(function () { return $(this).attr('data-value') === value; })
                .addClass('selected');
        }

        this.setPatternListOpen(false);
        this.validate();
    }

    bindEvents() {
        this.$patternSelectTrigger.on('click', (event) => {
            event.stopPropagation();
            this.setPatternListOpen(this.$patternSelectList.hasClass('hidden'));
        });

        this.$patternSelectList.on('click', (event) => {
            event.stopPropagation();
        });

        this.$patternSelectList.on('click', '.pattern-select-option', (event) => {
            // .attr(), not .data() - jQuery's .data() silently coerces
            // numeric-looking data-value strings (e.g. "51", "531") into
            // real Numbers, which then fail the strict string comparisons
            // in findPattern()/setPatternValue() below.
            this.setPatternValue($(event.currentTarget).attr('data-value'));
        });

        $(document).on('click', () => this.setPatternListOpen(false));

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
        this.$restartButton.on('click', () => this.restart());
        this.$muteButton.on('click', () => {
            this.soundtrack.toggleMuted();
            this.updateMuteButton();
        });
        this.$bpmSlider.on('input', () => this.setBpm(Number(this.$bpmSlider.val())));
        $(window).on('resize', () => this.handleResize());
        // 'R' restarts an active demo/game from the keyboard, same as the
        // button (see restart()) - only while one is actually running, and
        // only when the siteswap input isn't focused, so it doesn't hijack
        // someone typing a pattern that happens to contain the letter 'r'
        // (e.g. hex digits above 9).
        $(window).on('keydown', (event) => {
            if (event.repeat) return;
            if (event.key.toLowerCase() !== 'r') return;
            // Leave Ctrl/Cmd/Alt+R (e.g. the browser's own reload shortcut)
            // alone - only a bare 'r' press restarts.
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (!this.game && !this.simulator) return;
            if (document.activeElement === this.$input[0]) return;
            event.preventDefault();
            this.restart();
        });
    }

    /** Swaps the mute button's icon/title to match Soundtrack's current state. */
    updateMuteButton() {
        const muted = this.soundtrack.isMuted();
        this.$muteButton
            .find('.material-symbols-outlined')
            .text(muted ? 'volume_off' : 'volume_up');
        this.$muteButton.attr('title', muted ? 'Unmute' : 'Mute');
    }

    /** Swaps between the menu/demo/game screens - see index.less for what each body class actually shows/hides. */
    setMode(mode) {
        this.mode = mode;
        this.$body.attr('class', `mode-${mode}`);
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
            this.renderer.draw(this.buildDemoRenderState());
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
        const isCustom = this.patternValue === CUSTOM_PATTERN_VALUE;
        this.siteswap = SyncSiteswap.looksLikeSync(raw) ? SyncSiteswap.parse(raw) : Siteswap.parse(raw);

        if (this.siteswap.isValid) {
            this.$showMeButton.prop('disabled', false);
            this.$tryButton.prop('disabled', false);
        } else {
            this.$showMeButton.prop('disabled', true);
            this.$tryButton.prop('disabled', true);
        }

        this.updateValidationIcon(isCustom, raw);
    }

    /**
     * Custom siteswap only: a green check or red X at the right end of the
     * text input (see #validation-icon in index.html). Preset dropdown
     * picks are always valid, so nothing is shown for those. The full
     * validation sentence/error string lives in the icon's title tooltip.
     */
    updateValidationIcon(isCustom, raw) {
        const $glyph = this.$validationIcon.find('.material-symbols-outlined');

        if (!isCustom || raw.trim() === '') {
            this.$validationIcon.addClass('hidden').attr('title', '');
            return;
        }

        if (this.siteswap.isValid) {
            const { numBalls, period } = this.siteswap;
            const plural = numBalls === 1 ? '' : 's';
            $glyph.text('check_circle');
            this.$validationIcon
                .removeClass('hidden invalid')
                .addClass('valid')
                .attr('title', `Valid: ${numBalls} ball${plural}, period ${period}`);
        } else {
            $glyph.text('cancel');
            this.$validationIcon
                .removeClass('hidden valid')
                .addClass('invalid')
                .attr('title', this.siteswap.error);
        }
    }

    /** "Show me" - the fully automatic demo animation (previous behavior). */
    startDemo() {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.stop();
        // A click handler is exactly the user gesture browsers require
        // before an AudioContext is allowed to actually produce sound - see
        // Soundtrack.resume().
        this.soundtrack.resume();

        // #canvas-area is hidden (display: none) on the menu screen, so it
        // has to actually become visible - via setMode - before resize()
        // measures it, or it'd just measure a zero-size box.
        this.setMode('demo');
        this.renderer.resize();

        this.simulator = new JugglingSimulator(this.siteswap, {
            bpm: this.bpm,
            onBeat: (beatDurationSeconds, isNewPeriod) => {
                if (isNewPeriod) this.soundtrack.advancePeriod();
                this.soundtrack.playBeat(beatDurationSeconds);
            },
            onThrow: ({ hand, height, durationSeconds }) => this.soundtrack.playThrow({ hand, height, durationSeconds }),
        });
        this.renderer.fit(this.simulator.getExtent());
        this.lastTimestamp = performance.now();
        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    tick(timestamp) {
        const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
        this.lastTimestamp = timestamp;

        this.simulator.update(dt);
        this.renderer.draw(this.buildDemoRenderState());

        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    /**
     * getRenderState() plus bokehIntensity (see Renderer.drawBokeh) - the
     * scripted demo has no player "correctness" to key the fade-in off of
     * the way Game does (see its getBokehIntensity), so this substitutes
     * how far the beat clock currently is through the pattern's own
     * effectivePeriodForMusic cycle, landing at exactly the same instant/
     * threshold Soundtrack's own echo voice does either way (see
     * Soundtrack.getVisualProgress).
     */
    buildDemoRenderState() {
        const periodBeats = this.simulator.effectivePeriodForMusic;
        const fraction = periodBeats > 0 ? (this.simulator.nextBeat % periodBeats) / periodBeats : 0;
        return {
            ...this.simulator.getRenderState(),
            bokehIntensity: this.soundtrack.getVisualProgress(fraction),
        };
    }

    /** "Let me try!" - hands off to Game for everything from here on. */
    startGame() {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.stop();
        this.soundtrack.resume(); // See the matching comment in startDemo().

        // See the matching comment in startDemo() - the canvas needs to be
        // visible before anything measures it.
        this.setMode('game');
        this.renderer.resize();

        this.game = new Game(this.siteswap, {
            bpm: this.bpm,
            renderer: this.renderer,
            $beatBar: this.$beatBar,
            $beatBarWrap: this.$beatBarWrap,
            soundtrack: this.soundtrack,
        });
        this.game.start();
    }

    /**
     * Restarts whichever of "Show me" or "Let me try!" is currently
     * running, in place, without leaving that screen. The demo has no
     * player progress to preserve, so it's simplest to just replace it with
     * a fresh JugglingSimulator outright; Game instead has its own
     * resetState()-based restart() (see there) that keeps input attached
     * and the render loop running rather than tearing anything down.
     */
    restart() {
        if (this.game) {
            this.game.restart();
        } else if (this.simulator) {
            this.soundtrack.stopAll();
            this.simulator = new JugglingSimulator(this.siteswap, {
                bpm: this.bpm,
                onBeat: (beatDurationSeconds, isNewPeriod) => {
                    if (isNewPeriod) this.soundtrack.advancePeriod();
                    this.soundtrack.playBeat(beatDurationSeconds);
                },
                onThrow: ({ hand, height, durationSeconds }) => this.soundtrack.playThrow({ hand, height, durationSeconds }),
            });
            this.renderer.fit(this.simulator.getExtent());
            this.lastTimestamp = performance.now();
        }
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
        this.soundtrack.stopAll();
        this.renderer.draw({ balls: [] });
        this.setMode('menu');
    }
}
