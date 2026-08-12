import Siteswap from './Siteswap.js';
import SyncSiteswap from './SyncSiteswap.js';
import JugglingSimulator from './JugglingSimulator.js';
import Renderer from './Renderer.js';
import Game from './Game.js';
import Soundtrack from './Soundtrack.js';
import Settings from './Settings.js';
import Scores from './Scores.js';
import PatternSelection from './PatternSelection.js';
import MenuOrbAnimation from './MenuOrbAnimation.js';
import { isMobileViewport } from './mobile.js';
import { PATTERN_GROUPS, CUSTOM_PATTERN_VALUE, patternShowsSiteswap, findPattern } from './patterns.js';
import { buildControlsModalData } from './KeyboardInput.js';
import creditsModalTemplate from '../templates/credits-modal.handlebars';
import controlsModalTemplate from '../templates/controls-modal.handlebars';
import siteswapBasicsModalTemplate from '../templates/siteswap-basics-modal.handlebars';
import leaderboardModalTemplate from '../templates/leaderboard-modal.handlebars';
import leaderboardTableTemplate from '../templates/partials/leaderboard-table.handlebars';
import controlsBodyTemplate from '../templates/partials/controls-body.handlebars';
import gameOverModalTemplate from '../templates/game-over-modal.handlebars';
import gameOverBodyTemplate from '../templates/partials/game-over-body.handlebars';

// Lower sorts first - Harder > Normal > Easier (see sortLeaderboardScores).
const LEADERBOARD_DIFFICULTY_ORDER = {
    Harder: 0,
    Normal: 1,
    Easier: 2,
};

/** Sorts score rows: difficulty (harder first), pattern (A–Z), score (high–low). */
function sortLeaderboardScores(scores) {
    return [...scores].sort((a, b) => {
        const diffA = LEADERBOARD_DIFFICULTY_ORDER[a.difficulty] ?? 99;
        const diffB = LEADERBOARD_DIFFICULTY_ORDER[b.difficulty] ?? 99;
        if (diffA !== diffB) return diffA - diffB;

        const patternCmp = a.pattern.localeCompare(b.pattern, undefined, { sensitivity: 'base' });
        if (patternCmp !== 0) return patternCmp;

        return b.score - a.score;
    });
}

/**
 * Sorts `scores` and, if `highlightId` matches one of them, tags that entry
 * with `highlighted: true` for the score-table partial to mark (see
 * .leaderboard-row-highlight in index.less) - used by the Scores modal when
 * reopening after a score was saved this session (see openScoresModal).
 */
function buildScoreTableData(scores, { highlightId = null } = {}) {
    return sortLeaderboardScores(scores).map((entry) => (
        highlightId != null && entry.id === highlightId
            ? { ...entry, highlighted: true }
            : entry
    ));
}

// Which content-modal overlays render the shared score table (see
// score-table.handlebars) - openContentModal sorts/highlights `data.scores`
// for these before handing off to their body template, rather than every
// other content modal's plain pass-through (see there).
const SCORE_TABLE_OVERLAYS = new Set(['leaderboard-overlay']);

// Rendered into #app on startup (see App.renderContentModals) - each is a
// thin Handlebars partial block "inheriting" the shared shell in
// src/templates/partials/modal.handlebars. Add future text-content modals
// (not interactive ones like #settings-overlay) here. Each entry is called
// with no arguments; the score-table ones' initial (empty) render is never
// actually seen since both overlays start with the .hidden class and
// openContentModal always re-renders their body with real data before
// revealing them (see CONTENT_MODAL_BODY_TEMPLATES).
const CONTENT_MODAL_TEMPLATES = [
    creditsModalTemplate,
    () => controlsModalTemplate(buildControlsModalData()),
    siteswapBasicsModalTemplate,
    () => leaderboardModalTemplate({ scores: [] }),
    () => gameOverModalTemplate({ pattern: '', score: 0, difficulty: '' }),
];

// overlayId -> template for modals whose *body* needs re-rendering with
// fresh data every time they're reopened (see App.openContentModal), rather
// than only ever being rendered once at startup like the plain entries in
// CONTENT_MODAL_TEMPLATES above.
const CONTENT_MODAL_BODY_TEMPLATES = {
    'controls-overlay': controlsBodyTemplate,
    'leaderboard-overlay': leaderboardTableTemplate,
    'game-over-overlay': gameOverBodyTemplate,
};

// Competitive mode's per-difficulty tuning (see Game's constructor/
// recordThrowSequenceOutcome) - starting tempo, and how much BPM ramps up
// after each full progression through the chord pattern. `label` doubles as
// the "Difficulty" column value saved with a run's score (see
// handleGameOver/Scores.js), so it has to match LEADERBOARD_DIFFICULTY_ORDER's
// keys above.
const DIFFICULTY_CONFIG = {
    easier: { label: 'Easier', startBpm: 45, bpmIncrement: 3 },
    normal: { label: 'Normal', startBpm: 60, bpmIncrement: 5 },
    harder: { label: 'Harder', startBpm: 75, bpmIncrement: 7 },
};

const DEFAULT_BPM = 60;
const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).
// Keep in sync with @screen-fade-duration in index.less.
const SCREEN_FADE_MS = 550;
// Keep in sync with @picker-panel-slide-duration in index.less.
const PICKER_PANEL_SLIDE_MS = 350;

// Valid #picker-panels-track panel ids - main first, sub-menus after. Add
// future sub-menus here and as another .picker-panel sibling in index.html.
// Only two horizontal slots ever exist on screen at once (main, and
// whichever single sub-menu is active - see setPickerPanel), so this
// array's order doesn't affect layout, just which ids are recognized.
const PICKER_PANELS = ['main', 'difficulty', 'tutorial'];

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
        // Before anything below queries for #credits-overlay et al. - see
        // CONTENT_MODAL_TEMPLATES.
        this.renderContentModals();

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
        this.$contentModalOverlays = $('#credits-overlay, #controls-overlay, #siteswap-basics-overlay, #leaderboard-overlay, #game-over-overlay');
        this.$creditsLink = $('#credits-link');
        this.$streakValue = $('#streak-value');
        this.$maxStreakValue = $('#max-streak-value');
        this.$scoreValue = $('#score-value');
        this.$grooveCountdown = $('#groove-countdown');
        this.$grooveCountdownValue = $('#groove-countdown-value');
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
        // Competitive mode's score history (see Scores.js/handleGameOver) -
        // same read/write-through-localStorage shape as Settings above.
        this.scores = new Scores();
        // Id of the last score saved this session — cleared once the Scores
        // modal has been opened with it highlighted (see openScoresModal).
        this.recentScoreHighlightId = null;
        // Title-screen pattern picker (see PatternSelection.js).
        this.patternSelection = new PatternSelection();
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
        this.patternValue = this.patternSelection.getValue();

        this.buildPatternSelect();
        this.initPickerPanels();
        this.bindEvents();
        this.setMode('menu');
        this.handleResize();
        this.setPatternValue(this.patternValue);
        if (this.patternValue === CUSTOM_PATTERN_VALUE) {
            this.$input.val(this.patternSelection.getCustomSiteswap());
        }
        this.validate();
        this.updateMuteButton();
        this.syncSettingsPanel();
    }

    /** Renders every CONTENT_MODAL_TEMPLATES entry into #app, once, at startup. */
    renderContentModals() {
        const html = CONTENT_MODAL_TEMPLATES.map((template) => template()).join('');
        $('#app').append(html);
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
        this.patternSelection.setValue(value);
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

        this.$input.on('input', () => {
            if (this.patternValue === CUSTOM_PATTERN_VALUE) {
                this.patternSelection.setCustomSiteswap(this.$input.val());
            }
            this.validate();
        });
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
        this.bindPickerBackSwipe();
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
        this.bindContentModalEvents();
        // 'R' restarts an active demo/game from the keyboard, same as the
        // button (see restart()) - only while one is actually running, and
        // not while the player is typing in a text field (siteswap on the
        // menu, or a name on the Game Over modal).
        $(window).on('keydown', (event) => {
            if (event.repeat) return;
            if (event.key.toLowerCase() !== 'r') return;
            // Leave Ctrl/Cmd/Alt+R (e.g. the browser's own reload shortcut)
            // alone - only a bare 'r' press restarts.
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (!this.game && !this.simulator) return;
            if (!$('#game-over-overlay').hasClass('hidden')) return;
            if (document.activeElement === this.$input[0]) return;
            event.preventDefault();
            this.restart();
        });
    }

    /** Mobile-only: swipe right on #pattern-picker to return to the main menu panel. */
    bindPickerBackSwipe() {
        const SWIPE_MIN_PX = 50;
        const AXIS_DOMINANCE = 1.25; // ignore mostly-vertical drags
        let startX = 0;
        let startY = 0;
        let tracking = false;

        const canSwipeBack = () => (
            isMobileViewport()
            && this.mode === 'menu'
            && this.pickerPanelId !== PICKER_PANELS[0]
            && this.$patternSelectList.hasClass('hidden')
        );

        this.$patternPicker.addEventListener('touchstart', (event) => {
            if (!canSwipeBack()) return;
            if (event.touches.length !== 1) return;
            const touch = event.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            tracking = true;
        }, { passive: true });

        this.$patternPicker.addEventListener('touchmove', (event) => {
            if (!tracking || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            // A mostly-vertical drag is probably scrolling elsewhere — bail.
            if (Math.abs(deltaY) > SWIPE_MIN_PX && Math.abs(deltaY) > Math.abs(deltaX)) {
                tracking = false;
            }
        }, { passive: true });

        const finishSwipe = (event) => {
            if (!tracking) return;
            tracking = false;
            if (!canSwipeBack()) return;
            const touch = event.changedTouches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            if (deltaX < SWIPE_MIN_PX) return;
            if (Math.abs(deltaX) < Math.abs(deltaY) * AXIS_DOMINANCE) return;
            this.setPickerPanel('main');
        };

        this.$patternPicker.addEventListener('touchend', finishSwipe, { passive: true });
        this.$patternPicker.addEventListener('touchcancel', () => {
            tracking = false;
        }, { passive: true });
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
            if (this.closeOpenContentModal()) return;
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

    bindContentModalEvents() {
        this.$contentModalOverlays.each((_, overlay) => {
            const $overlay = $(overlay);
            $overlay.find('.app-modal-close').on('click', () => this.closeContentModal($overlay));
            $overlay.on('click', (event) => {
                // Game Over has no close affordance - saving is the only way
                // out (see game-over-modal.handlebars's hideClose).
                if ($overlay.is('#game-over-overlay')) return;
                if (event.target === overlay) this.closeContentModal($overlay);
            });
        });
        this.$creditsLink.on('click', () => this.openContentModal('credits-overlay'));

        // Delegated (not bound directly to the button) since the leaderboard
        // overlay's .app-modal-body is replaced wholesale on every re-render
        // (see openContentModal) - a direct binding would go stale the
        // moment it's reopened.
        $('#leaderboard-overlay').on('click', '[data-action="leaderboard-reset"]', () => {
            this.scores.resetAll();
            this.recentScoreHighlightId = null;
            this.openScoresModal();
        });
        $('#game-over-overlay').on('click', '[data-action="game-over-save"]', () => this.saveGameOverScore());
        $('#game-over-overlay').on('keydown', '#game-over-name-input', (event) => {
            if (event.key === 'Enter') this.saveGameOverScore();
        });
    }

    /** Opens the Scores modal, highlighting the last score saved this session (if any) with a one-time fade. */
    openScoresModal() {
        const highlightId = this.recentScoreHighlightId;
        this.recentScoreHighlightId = null;
        this.openContentModal('leaderboard-overlay', {
            scores: this.scores.getAll(),
            ...(highlightId != null ? { highlightId } : {}),
        });
    }

    /**
     * Opens a text-content modal. If `data` is passed and the overlay has a
     * matching entry in CONTENT_MODAL_BODY_TEMPLATES, its .app-modal-body is
     * re-rendered with that data first - e.g. the leaderboard passing fresh
     * `{ scores }` each time it's reopened (see CONTENT_MODAL_TEMPLATES).
     * Modals with no such entry (credits, siteswap-basics) just ignore
     * `data` and show as-is. Controls passes fresh bindings each open (see
     * buildControlsModalData). Leaderboard-only: `data.highlightId`
     * flags a row for score-table.handlebars to mark and scrolls it into
     * view (see scrollToHighlightedScoreRow).
     */
    openContentModal(overlayId, data) {
        const bodyTemplate = CONTENT_MODAL_BODY_TEMPLATES[overlayId];
        if (bodyTemplate && data) {
            const renderData = SCORE_TABLE_OVERLAYS.has(overlayId)
                ? { ...data, scores: buildScoreTableData(data.scores || [], { highlightId: data.highlightId }) }
                : data;
            $(`#${overlayId} .app-modal-body`).html(bodyTemplate(renderData));
            if (data.highlightId) this.scrollToHighlightedScoreRow(overlayId);
        }
        $(`#${overlayId}`).removeClass('hidden');
    }

    /** Scrolls a just-rendered score-table overlay so its newly-highlighted row (see openContentModal) is actually in view, not just marked. */
    scrollToHighlightedScoreRow(overlayId) {
        requestAnimationFrame(() => {
            const row = document.querySelector(`#${overlayId} .leaderboard-row-highlight`);
            if (row) row.scrollIntoView({ block: 'center' });
        });
    }

    closeContentModal($overlay) {
        $overlay.addClass('hidden');
        // The Game Over modal (see handleGameOver) is shown "in place",
        // straight over gameplay's own last (frozen) frame, rather than
        // after already returning to the menu underneath - so the actual
        // return trip to the menu happens once it's dismissed (see
        // returnToMenuAfterGameOver).
        if ($overlay.is('#game-over-overlay')) this.returnToMenuAfterGameOver();
    }

    /** Closes whichever text-content modal is open, if any. Returns true if one was closed. Game Over is excluded - it has no dismiss affordance (see game-over-modal.handlebars). */
    closeOpenContentModal() {
        const $open = this.$contentModalOverlays.not('.hidden').first();
        if (!$open.length) return false;
        if ($open.is('#game-over-overlay')) return false;
        this.closeContentModal($open);
        return true;
    }

    openSettings() {
        this.$settingsOverlay.removeClass('hidden');
    }

    closeSettings() {
        this.$settingsOverlay.addClass('hidden');
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

    /**
     * Swaps between the menu/demo/game screens - see index.less for what
     * each body class actually shows/hides. Pass null for a blank body
     * (everything hidden) between staged transitions. `competitive` (only
     * meaningful alongside mode: 'game' - see startGame) adds a second body
     * class that swaps the streak/best HUD and BPM slider for competitive
     * mode's single score stat (see body.mode-competitive in index.less) -
     * folded into this one class-setting call, rather than a separate
     * toggleClass, since this method already fully replaces the body's
     * class attribute on every other call anyway.
     */
    setMode(mode, { competitive = false } = {}) {
        const leavingMenu = this.mode === 'menu' && mode !== 'menu';
        this.mode = mode;
        // Built up rather than a `mode ? ... : ''` one-liner - competitive
        // needs to survive mode: null too (see returnToMenuAfterGameOver's
        // fade-to-black), which a short-circuiting ternary on `mode` alone
        // would silently drop regardless of what was passed for it.
        const classes = [];
        if (mode) classes.push(`mode-${mode}`);
        if (competitive) classes.push('mode-competitive');
        this.$body.attr('class', classes.join(' '));
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
                this.startGame({ mode: 'practice' });
                break;
            case 'tutorial':
                this.setPickerPanel('tutorial');
                break;
            case 'leaderboard':
                this.openScoresModal();
                break;
            case 'difficulty-easier':
                this.startGame({ mode: 'competitive', difficulty: 'easier' });
                break;
            case 'difficulty-normal':
                this.startGame({ mode: 'competitive', difficulty: 'normal' });
                break;
            case 'difficulty-harder':
                this.startGame({ mode: 'competitive', difficulty: 'harder' });
                break;
            case 'interactive-tutorial':
                console.log('Starting interactive tutorial');
                break;
            case 'tutorial-controls':
                this.openContentModal('controls-overlay', buildControlsModalData(undefined, {
                    inputType: this.settings.get('inputType'),
                }));
                break;
            case 'tutorial-siteswap-basics':
                this.openContentModal('siteswap-basics-overlay');
                break;
            default:
                break;
        }
    }

    /** Sets up the horizontal picker track (see #picker-panels-* in index.less). */
    initPickerPanels() {
        // Always 2, not PICKER_PANELS.length - see the matching comment on
        // #picker-panels-track in index.less for why.
        this.$patternPicker.style.setProperty('--picker-panel-count', 2);
        this.setPickerPanel(PICKER_PANELS[0], { instant: true });
    }

    /**
     * Slides #picker-panels-track to the named panel. Main is leftmost;
     * whichever sub-menu is named slides in from the right (see
     * .picker-panel--active-sub in index.less - CSS order, not this
     * method's index, is what actually places it there), so switching
     * straight from one sub-menu to another never visibly passes through
     * a third. #picker-back-button stays fixed on the viewport and fades
     * in for any sub-menu.
     */
    setPickerPanel(panelId, { instant = false } = {}) {
        if (!PICKER_PANELS.includes(panelId)) return;

        if (panelId !== PICKER_PANELS[0]) this.setPatternListOpen(false);

        const previousPanelId = this.pickerPanelId;
        this.pickerPanelId = panelId;
        const onSubMenu = panelId !== PICKER_PANELS[0];
        const wasOnSubMenu = previousPanelId !== PICKER_PANELS[0];
        const index = onSubMenu ? 1 : 0;
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

        // The incoming sub-menu (if any) has to claim the shared slot right
        // away, before the slide even starts - it needs to already be
        // sitting there for the slide's very first frame.
        if (onSubMenu) {
            this.$pickerPanelsTrack.find(`[data-picker-panel="${panelId}"]`).addClass('picker-panel--active-sub');
        }
        // The outgoing sub-menu (if any), conversely, only gives the slot up
        // once it's actually finished sliding out of view - order isn't
        // animatable, so releasing it immediately would let whichever
        // *other* sub-menu is next in DOM order instantly (not gradually)
        // take its place mid-slide, flashing that other panel's content in
        // transit (see .picker-panel--active-sub in index.less).
        if (wasOnSubMenu && previousPanelId !== panelId) {
            const $outgoing = this.$pickerPanelsTrack.find(`[data-picker-panel="${previousPanelId}"]`);
            if (instant) {
                $outgoing.removeClass('picker-panel--active-sub');
            } else {
                setTimeout(() => {
                    if (this.pickerPanelId !== panelId) return; // Superseded by a newer call before the slide settled.
                    $outgoing.removeClass('picker-panel--active-sub');
                }, PICKER_PANEL_SLIDE_MS);
            }
        }

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

    /** Display name for whatever pattern is currently selected - used to label a competitive run's saved score (see handleGameOver). */
    getCurrentPatternName() {
        if (this.patternValue === CUSTOM_PATTERN_VALUE) {
            return this.$input.val().trim() || 'Custom';
        }
        return findPattern(this.patternValue)?.name || this.patternValue;
    }

    /**
     * "Let me try!" - hands off to Game for everything from here on.
     * `mode`/`difficulty` distinguish practice (the only mode before
     * competitive existed - see the difficulty sub-menu's own "Practice
     * mode" button) from competitive play at a chosen difficulty (see
     * DIFFICULTY_CONFIG and the difficulty-* menu actions).
     */
    startGame({ mode = 'practice', difficulty = null } = {}) {
        if (!this.siteswap || !this.siteswap.isValid) return;
        this.clearSession();

        const difficultyConfig = mode === 'competitive' ? DIFFICULTY_CONFIG[difficulty] : null;
        const pattern = this.getCurrentPatternName();

        // Staged transition: fade the title screen out on its own (still
        // showing whichever sub-menu was open), reset the picker once it's
        // invisible, then fade gameplay in - no menu/game cross-dissolve.
        const startToken = this.startToken;
        this.setMode(null);
        waitMs(SCREEN_FADE_MS).then(() => {
            if (startToken !== this.startToken) return;

            this.setPickerPanel(PICKER_PANELS[0], { instant: true });
            this.setMode('game', { competitive: mode === 'competitive' });
            this.renderer.resize();

            // Start drawing immediately as the canvas fades in, rather than
            // waiting for the fade to finish (which left a blank screen that
            // suddenly popped into gameplay).
            this.game = new Game(this.siteswap, {
                bpm: difficultyConfig ? difficultyConfig.startBpm : this.bpm,
                renderer: this.renderer,
                $beatBar: this.$beatBar,
                $beatBarWrap: this.$beatBarWrap,
                $streakValue: this.$streakValue,
                $maxStreakValue: this.$maxStreakValue,
                soundtrack: this.soundtrack,
                settings: this.settings,
                mode,
                difficultyConfig,
                $scoreValue: this.$scoreValue,
                $grooveCountdown: this.$grooveCountdown,
                $grooveCountdownValue: this.$grooveCountdownValue,
                onGameOver: ({ score }) => this.handleGameOver({ score, difficulty: difficultyConfig?.label, pattern }),
            });
            this.game.start();

            return this.soundtrack.resume();
        });
    }

    /**
     * A competitive run just ended (see Game.triggerGameOver) - shows the
     * Game Over modal right away, straight over gameplay's own last
     * (frozen) frame, rather than only after already fading back to the
     * menu underneath it (see closeContentModal/returnToMenuAfterGameOver
     * for that trip, deferred until the player's actually done with this
     * modal). The score itself isn't saved yet - see
     * saveGameOverScore/game-over-body.handlebars's name field - saving is
     * the only way out (see game-over-modal.handlebars's hideClose).
     */
    handleGameOver({ score, difficulty, pattern }) {
        this.pendingGameOverScore = { score, difficulty, pattern };
        this.openContentModal('game-over-overlay', { pattern, score, difficulty });
        requestAnimationFrame(() => $('#game-over-name-input').trigger('focus'));
    }

    /**
     * Runs stop()'s own fade-to-black-then-menu transition once the Game
     * Over modal (see handleGameOver) has actually been dismissed. The
     * modal (already fading itself out via closeContentModal's addClass
     * ('hidden')) and the frozen gameplay screen underneath it fade out
     * together, rather than staging one after the other - its backdrop
     * already fully covers that frozen frame for as long as it's up
     * anyway, so there's nothing to see (or pop) either way. Keeps
     * mode-competitive on through the fade, or #practice-stat-group's
     * streak/best would flash back into view the instant that class
     * would otherwise drop mid-fade (see body.mode-competitive in
     * index.less).
     */
    returnToMenuAfterGameOver() {
        if (this.mode !== 'game') return; // Already left - e.g. the modal somehow got closed twice.

        const stopToken = this.startToken;
        const competitive = Boolean(this.game && this.game.isCompetitive);
        this.setMode(null, { competitive });

        waitMs(SCREEN_FADE_MS).then(() => {
            if (stopToken !== this.startToken) return;

            // Don't blank the canvas until gameplay's fade is fully done and
            // the menu layer has taken over (see clearSession's clearCanvas).
            this.clearSession({ clearCanvas: false });
            this.setPickerPanel(PICKER_PANELS[0], { instant: true });
            this.setMode('menu');
            this.renderer.draw({ balls: [] });
        });
    }

    /** Commits the just-finished competitive run (see handleGameOver), then closes the modal and returns to the menu. */
    saveGameOverScore() {
        if (!this.pendingGameOverScore) return;
        const name = $('#game-over-name-input').val();
        const entry = this.scores.add({ ...this.pendingGameOverScore, player: name });
        this.recentScoreHighlightId = entry.id;
        this.pendingGameOverScore = null;
        this.closeContentModal($('#game-over-overlay'));
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

    /** Tears down any running demo/game and clears audio/canvas, without changing menu mode or picker state. Pass clearCanvas: false when the gameplay layer may still be finishing its own fade-out (see returnToMenuAfterGameOver). */
    clearSession({ clearCanvas = true } = {}) {
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
        if (clearCanvas) this.renderer.draw({ balls: [] });
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
