import Siteswap from './Siteswap.js';
import SyncSiteswap from './SyncSiteswap.js';
import JugglingSimulator from './JugglingSimulator.js';
import Renderer from './Renderer.js';
import Game from './Game.js';
import Soundtrack from './Soundtrack.js';
import Settings from './Settings.js';
import MenuOrbAnimation from './MenuOrbAnimation.js';
import { PATTERN_GROUPS, CUSTOM_PATTERN_VALUE, patternShowsSiteswap, findPattern } from './patterns.js';

const DEFAULT_BPM = 60;
const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).
// Keep in sync with @screen-fade-duration in index.less.
const SCREEN_FADE_MS = 550;
// Keep in sync with @picker-panel-slide-duration in index.less.
const PICKER_PANEL_SLIDE_MS = 350;

// Ordered left-to-right on #picker-panels-track (main first, sub-menus after).
// Add future sub-menus here and as another .picker-panel sibling in index.html.
const PICKER_PANELS = ['main', 'difficulty'];

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        this.$patternPicker = document.getElementById('pattern-picker');
        this.$pickerPanelsTrack = $('#picker-panels-track');
        this.$pickerBackButton = $('#picker-back-button');
        this.$patternSelectTrigger = $('#pattern-select-trigger');
        this.$patternSelectList = $('#pattern-select-list');
        this.$customInputWrap = $('#custom-input-wrap');
        this.$input = $('#siteswap-input');
        this.$menuButtons = $('#menu-buttons');
        this.$menuSpacer = $('#menu-spacer');
        this.$stopButton = $('#stop-button');
        this.$restartButton = $('#restart-button');
        this.$muteButton = $('#mute-button');
        this.$settingsButton = $('#settings-button');
        this.$settingsOverlay = $('#settings-overlay');
        this.$settingsCloseButton = $('#settings-close-button');
        this.$settingsResetButton = $('#settings-reset-button');
        this.$creditsOverlay = $('#credits-overlay');
        this.$creditsCloseButton = $('#credits-close-button');
        this.$creditsLink = $('#credits-link');
        this.$streakValue = $('#streak-value');
        this.$maxStreakValue = $('#max-streak-value');
        this.$validationIcon = $('#validation-icon');
        this.$bpmSlider = $('#bpm-slider');
        this.$bpmValue = $('#bpm-value');
        this.$beatBarWrap = $('#beat-bar-wrap');
        this.$beatBar = $('#beat-bar');
        this.canvas = document.getElementById('juggle-canvas');

        // Persisted player preferences (see Settings.js) - handed by
        // reference to Renderer (backgroundEffect) and every Game instance
        // (inputType), which each just read the live value straight off it
        // rather than needing a change notification (see there).
        this.settings = new Settings();
        this.renderer = new Renderer(this.canvas, { settings: this.settings });
        // Device/browser can't run the real fluid sim at all (see
        // FluidSimulation.tryCreate/Renderer.fluid) - hide the option
        // outright rather than leaving a picker that never actually
        // does anything on this device (see syncSettingsPanel, which
        // also treats a stored 'fluid' preference as 'bokeh' for
        // highlighting purposes so nothing appears deselected below).
        if (!this.renderer.fluid) {
            $('.settings-option[data-value="fluid"]').addClass('hidden');
        }
        // Shared for the whole page's life - both the demo's JugglingSimulator
        // and Game get the same instance (see startDemo/startGame), so a mute
        // toggled mid-demo stays muted if the player then switches to "Let me
        // try!" without needing to reconcile two separate mute states.
        this.soundtrack = new Soundtrack({ settings: this.settings });
        this.menuOrbAnimation = new MenuOrbAnimation(this.$patternPicker);
        this.siteswap = null;
        // Only set while the "Show me" demo animation is actually running.
        this.simulator = null;
        // Only set while "Let me try!" gameplay mode is active.
        this.game = null;
        this.rafId = null;
        this.lastTimestamp = 0;
        // Bumped by stop() and by every startDemo/startGame call - lets
        // either method's pending soundtrack.resume() (see there) recognize
        // that it's been superseded by a newer start/stop before it settles,
        // rather than going ahead and starting a second simulator/game on
        // top of whatever's now actually current.
        this.startToken = 0;
        this.pickerPanelId = PICKER_PANELS[0];
        this.bpm = Number(this.$bpmSlider.val()) || DEFAULT_BPM;
        this.patternValue = PATTERN_GROUPS[0].patterns[0].value;

        this.buildPatternSelect();
        this.initPickerPanels();
        this.bindEvents();
        this.setMode('menu');
        this.handleResize();
        this.setPatternValue(this.patternValue);
        this.updateMuteButton();
        this.syncSettingsPanel();
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

        if (open) {
            this.positionPatternSelectList();
            const selected = this.$patternSelectList.find('.pattern-select-option.selected')[0];
            (selected || this.$patternSelectList[0]).scrollIntoView({ block: 'nearest' });
        }
    }

    /** Keeps the portaled #pattern-select-list aligned under its trigger. */
    positionPatternSelectList() {
        if (this.$patternSelectList.hasClass('hidden')) return;

        const rect = this.$patternSelectTrigger[0].getBoundingClientRect();
        this.$patternSelectList.css({
            top: rect.bottom,
            left: rect.left,
            width: rect.width,
        });
    }

    setPatternValue(value) {
        this.patternValue = value;
        this.$patternSelectList.find('.pattern-select-option').removeClass('selected');

        if (value === CUSTOM_PATTERN_VALUE) {
            this.renderPatternTrigger('Custom\u2026');
            this.$customInputWrap.removeClass('hidden');
            this.$menuSpacer.addClass('hidden');
            this.$input.trigger('focus');
        } else {
            const pattern = findPattern(value);
            this.renderPatternTrigger(pattern.name);
            this.$customInputWrap.addClass('hidden');
            this.$menuSpacer.removeClass('hidden');
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
        $(this.$patternPicker).on('click', '.action-button[data-action]', (event) => {
            const $button = $(event.currentTarget);
            if ($button.prop('disabled')) return;
            this.handleMenuAction($button.attr('data-action'));
        });
        this.$pickerBackButton.on('click', () => this.setPickerPanel('main'));
        this.$stopButton.on('click', () => this.stop());
        this.$restartButton.on('click', () => this.restart());
        this.$muteButton.on('click', () => {
            this.soundtrack.toggleMuted();
            this.updateMuteButton();
        });
        this.$bpmSlider.on('input', () => this.setBpm(Number(this.$bpmSlider.val())));
        $(window).on('resize', () => {
            this.handleResize();
            this.positionPatternSelectList();
        });
        this.bindSettingsEvents();
        this.bindCreditsEvents();
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

    bindSettingsEvents() {
        this.$settingsButton.on('click', () => this.openSettings());
        this.$settingsCloseButton.on('click', () => this.closeSettings());
        // Clicking the darkened backdrop itself (not anything inside the
        // modal, which stops its own clicks from bubbling here - see
        // below) closes it too, same as the X.
        this.$settingsOverlay.on('click', (event) => {
            if (event.target === this.$settingsOverlay[0]) this.closeSettings();
        });
        $(window).on('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (!this.$creditsOverlay.hasClass('hidden')) this.closeCredits();
            else if (!this.$settingsOverlay.hasClass('hidden')) this.closeSettings();
            else if (this.pickerPanelId !== PICKER_PANELS[0]) this.setPickerPanel('main');
        });

        this.$settingsOverlay.find('.settings-option-row').on('click', '.settings-option', (event) => {
            const $row = $(event.currentTarget).closest('.settings-option-row');
            const key = $row.attr('data-setting');
            const value = $(event.currentTarget).attr('data-value');
            this.applySetting(key, value);
        });

        this.$settingsOverlay.on('click', '.settings-toggle', (event) => {
            const key = $(event.currentTarget).attr('data-setting');
            const next = this.settings.get(key) === 'on' ? 'off' : 'on';
            this.applySetting(key, next);
        });

        this.$settingsResetButton.on('click', () => {
            this.settings.resetToDefaults();
            this.syncSettingsPanel();
            if (this.settings.get('backgroundEffect') !== 'fluid') {
                this.renderer.fluid?.reset();
            }
        });
    }

    bindCreditsEvents() {
        this.$creditsLink.on('click', () => this.openCredits());
        this.$creditsCloseButton.on('click', () => this.closeCredits());
        this.$creditsOverlay.on('click', (event) => {
            if (event.target === this.$creditsOverlay[0]) this.closeCredits();
        });
    }

    openSettings() {
        this.$settingsOverlay.removeClass('hidden');
    }

    closeSettings() {
        this.$settingsOverlay.addClass('hidden');
    }

    openCredits() {
        this.$creditsOverlay.removeClass('hidden');
    }

    closeCredits() {
        this.$creditsOverlay.addClass('hidden');
    }

    /**
     * Applies one setting change everywhere it needs to take effect
     * immediately - persisting it (see Settings.set), then updating
     * whatever's currently on screen so a change made mid-demo/game shows
     * up right away rather than only after a restart. Renderer/Game
     * themselves just read settings.get(key) fresh each time they need it
     * (see there), so the only "push" work here is the parts that cache a
     * derived value up front rather than re-deriving it every frame:
     * Renderer's fluid sim needs an explicit reset() when the effect is
     * switched away from 'fluid' so it doesn't sit there stale, mid-swirl,
     * for whenever it's switched back on.
     */
    applySetting(key, value) {
        this.settings.set(key, value);
        this.syncSettingsPanel();
        if (key === 'backgroundEffect' && value !== 'fluid') {
            this.renderer.fluid?.reset();
        }
    }

    /** Highlights whichever option each setting group's current value matches - called on open and after every change (including reset). */
    syncSettingsPanel() {
        this.$settingsOverlay.find('.settings-option-row').each((_, row) => {
            const $row = $(row);
            const key = $row.attr('data-setting');
            let value = this.settings.get(key);
            // Fluid's own button is hidden on devices that can't run it
            // (see constructor) - Renderer already falls back to bokeh
            // behind the scenes for a stored 'fluid' preference on such a
            // device, so highlight that same fallback here too rather
            // than leaving nothing selected.
            if (key === 'backgroundEffect' && value === 'fluid' && !this.renderer.fluid) value = 'bokeh';
            $row.find('.settings-option')
                .removeClass('selected')
                .filter(function () { return $(this).attr('data-value') === value; })
                .addClass('selected');
        });
        this.$settingsOverlay.find('.settings-toggle').each((_, button) => {
            const $button = $(button);
            const key = $button.attr('data-setting');
            $button.toggleClass('selected', this.settings.get(key) === 'on');
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

    /** Swaps between the menu/demo/game screens - see index.less for what each body class actually shows/hides. Pass null for a blank body (everything hidden) between staged transitions. */
    setMode(mode) {
        const leavingMenu = this.mode === 'menu' && mode !== 'menu';
        this.mode = mode;
        this.$body.attr('class', mode ? `mode-${mode}` : '');
        if (mode === 'menu') {
            this.menuOrbAnimation.start();
        } else if (leavingMenu) {
            // Keep orbs moving through the title-screen fade rather than
            // snapping to their t = 0 pose the instant the mode flips.
            this.menuOrbAnimation.stopAfter(SCREEN_FADE_MS);
        } else if (mode) {
            this.menuOrbAnimation.stop();
        }
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

    /** Dispatches a title-screen menu button press (see #menu-buttons' data-action). */
    handleMenuAction(action) {
        switch (action) {
            case 'show-me':
                this.startDemo();
                break;
            case 'try':
                // "Juggle" opens the difficulty sub-menu (see setPickerPanel).
                this.setPickerPanel('difficulty');
                break;
            case 'practice':
                this.startGame();
                break;
            case 'tutorial':
                // TODO: guided tutorial mode.
                break;
            case 'compete':
                // TODO: competitive/challenge mode.
                break;
            case 'leaderboard':
                // TODO: leaderboard screen.
                break;
            case 'difficulty-easier':
            case 'difficulty-normal':
            case 'difficulty-harder':
                // TODO: start gameplay at the chosen difficulty.
                break;
            default:
                break;
        }
    }

    /** Sets up the horizontal picker track (see #picker-panels-* in index.less). */
    initPickerPanels() {
        this.$patternPicker.style.setProperty('--picker-panel-count', PICKER_PANELS.length);
        this.setPickerPanel(PICKER_PANELS[0], { instant: true });
    }

    /**
     * Slides #picker-panels-track to the named panel. Main is leftmost;
     * sub-menus sit to its right and slide in when selected.
     * #picker-back-button stays fixed on the viewport and fades in for any sub-menu.
     */
    setPickerPanel(panelId, { instant = false } = {}) {
        const index = PICKER_PANELS.indexOf(panelId);
        if (index < 0) return;

        if (panelId !== PICKER_PANELS[0]) this.setPatternListOpen(false);

        this.pickerPanelId = panelId;
        const onSubMenu = panelId !== PICKER_PANELS[0];
        const track = this.$pickerPanelsTrack[0];
        const backButton = this.$pickerBackButton[0];
        if (instant) {
            track.style.transition = 'none';
            backButton.style.transition = 'none';
        }
        this.$patternPicker.style.setProperty('--picker-panel-index', index);
        this.$patternPicker.setAttribute('data-picker-panel', panelId);
        this.$pickerBackButton.toggleClass('visible', onSubMenu);
        this.$pickerBackButton.attr('aria-hidden', onSubMenu ? 'false' : 'true');
        this.$pickerPanelsTrack.find('.picker-panel').each((_, panel) => {
            const isActive = panel.getAttribute('data-picker-panel') === panelId;
            panel.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        });
        if (instant) {
            // Force reflow so the next slide/fade still animates.
            track.offsetHeight;
            track.style.transition = '';
            backButton.style.transition = '';
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
            this.$menuButtons.find('[data-action]').prop('disabled', false);
        } else {
            this.$menuButtons.find('[data-action]').prop('disabled', true);
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
        this.stop({ animated: false });

        // #canvas-area is opacity-hidden on the menu screen, so setMode has
        // to run before resize() measures it, or it'd measure a zero-size box.
        this.setMode('demo');
        this.renderer.resize();
        this.renderer.resetIntensity();

        // A click handler is exactly the user gesture browsers require
        // before an AudioContext is allowed to actually produce sound - see
        // Soundtrack.resume() - but resume() itself is async, and the
        // simulator's very first beat/throw fires on literally its first
        // update() (both nextBeatTime and time start at 0 - see
        // JugglingSimulator.update()), i.e. the very next animation frame
        // after this returns. Waiting for resume() to actually settle
        // before building the simulator/starting the tick loop is what
        // keeps that first beat from ever being scheduled against a still-
        // suspended context - which otherwise gets silently dropped once
        // the context does wake up, misread as a warm-up hiccup. Also wait
        // out the menu→demo crossfade (see SCREEN_FADE_MS / index.less) so
        // juggling doesn't start underneath a still-fading title screen.
        const startToken = ++this.startToken;
        Promise.all([this.soundtrack.resume(), waitMs(SCREEN_FADE_MS)]).then(() => {
            if (startToken !== this.startToken) return; // Superseded by a newer start/stop before we settled.

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
        });
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
     *
     * Deliberately *not* `nextBeat % periodBeats` (how many beats into the
     * pattern the *next*, not-yet-played beat sits) - `nextBeat` only
     * advances past a period boundary the instant *after* that boundary
     * beat's own onBeat callback has already fired advancePeriod() for it
     * (see JugglingSimulator.update/processBeat), so for exactly one beat
     * per period, a plain `nextBeat % periodBeats` has already wrapped
     * back to 0 - claiming a new period has begun - while
     * soundtrack.periodsCompleted hasn't actually been incremented to
     * match yet, one full beat behind. getVisualProgress combines the two
     * by simply adding them, so that one-beat lag briefly reads as *less*
     * total progress than the beat before it - a real dip, not just this
     * effect's own fade-in - before recovering once periodsCompleted
     * catches up. Counting *completed* beats (nextBeat - 1, floored to 0)
     * instead keeps this in lockstep with periodsCompleted's own timing:
     * it only wraps back to (a full) 1 - not 0 - on exactly the beat
     * whose own onBeat call is what increments periodsCompleted, so the
     * two combine continuously with no lag in either direction.
     */
    buildDemoRenderState() {
        const periodBeats = this.simulator.effectivePeriodForMusic;
        const beatsPlayed = Math.max(0, this.simulator.nextBeat - 1);
        const fraction = periodBeats > 0 ? ((beatsPlayed % periodBeats) + 1) / periodBeats : 0;
        return {
            ...this.simulator.getRenderState(),
            bokehIntensity: this.soundtrack.getVisualProgress(this.simulator.nextBeat > 0 ? fraction : 0),
        };
    }

    /** "Let me try!" - hands off to Game for everything from here on. */
    startGame() {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.clearSession();

        // Staged transition: fade the title screen out on its own (still
        // showing whichever sub-menu was open), reset the picker once it's
        // invisible, then fade gameplay in - no menu/game cross-dissolve.
        const startToken = this.startToken;
        this.setMode(null);
        waitMs(SCREEN_FADE_MS).then(() => {
            if (startToken !== this.startToken) return;

            this.setPickerPanel(PICKER_PANELS[0], { instant: true });
            this.setMode('game');
            this.renderer.resize();

            // Start drawing immediately as the canvas fades in, rather than
            // waiting for the fade to finish (which left a blank screen that
            // suddenly popped into gameplay).
            this.game = new Game(this.siteswap, {
                bpm: this.bpm,
                renderer: this.renderer,
                $beatBar: this.$beatBar,
                $beatBarWrap: this.$beatBarWrap,
                $streakValue: this.$streakValue,
                $maxStreakValue: this.$maxStreakValue,
                soundtrack: this.soundtrack,
                settings: this.settings,
            });
            this.game.start();

            return this.soundtrack.resume();
        });
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
            this.renderer.resetIntensity();
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

    /** Tears down any running demo/game and clears audio/canvas, without changing menu mode or picker state. */
    clearSession() {
        // Invalidates any startDemo/startGame still waiting on a transition
        // or soundtrack.resume() (see there).
        this.startToken++;
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
    }

    stop({ animated = true } = {}) {
        const leavingActiveScreen = this.mode === 'game' || this.mode === 'demo';

        if (!animated || !leavingActiveScreen) {
            this.clearSession();
            this.setMode('menu');
            this.setPickerPanel(PICKER_PANELS[0], { instant: true });
            return;
        }

        // Staged transition (mirror of startGame): fade gameplay out on its
        // own while the sim/game keeps drawing, tear down once invisible,
        // reset the picker, then fade the menu in.
        const stopToken = this.startToken;
        this.setMode(null);

        waitMs(SCREEN_FADE_MS).then(() => {
            if (stopToken !== this.startToken) return;

            this.clearSession();
            this.setPickerPanel(PICKER_PANELS[0], { instant: true });
            this.setMode('menu');
        });
    }
}
