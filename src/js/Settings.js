const STORAGE_KEY = 'pixel-juggle-settings';

// Every setting's default value, doubling as the full set of known setting
// keys/valid values below (see loadStored) - add a new setting here first.
export const DEFAULT_SETTINGS = {
    // 'fluid' (WebGL fluid sim, falling back to 'bokeh' on unsupported
    // devices - see FluidSimulation.tryCreate/Renderer), 'bokeh' (forces
    // the fallback even where fluid would work), or 'off' (no background
    // wash at all).
    backgroundEffect: 'fluid',
    // 'hold' (charge up a throw height by holding the key, release to lock
    // it in - see Game.handleThrowStart) or 'tap' (each press instead
    // immediately cycles the locked height up by one ring - see
    // Game.handleTapThrow).
    inputType: 'hold',
    // Independent on/off toggles for each sound category (see
    // Soundtrack.isSoundCategoryEnabled) - the in-game mute button
    // temporarily silences everything via master gain without changing
    // these persisted values.
    soundPercussion: 'on',
    soundThrowTones: 'on',
    soundButtons: 'on',
    // On/off toggles for in-game HUD labels (see Renderer.drawThrowHeightWedge).
    uiLabelHands: 'on',
    uiLabelHeights: 'on',
    uiLabelHotkeys: 'off',
};

const VALID_VALUES = {
    backgroundEffect: ['fluid', 'bokeh', 'off'],
    inputType: ['hold', 'tap'],
    soundPercussion: ['on', 'off'],
    soundThrowTones: ['on', 'off'],
    soundButtons: ['on', 'off'],
    uiLabelHands: ['on', 'off'],
    uiLabelHeights: ['on', 'off'],
    uiLabelHotkeys: ['on', 'off'],
};

const LEGACY_MUTED_STORAGE_KEY = 'pixel-juggle-muted';

const SOUND_CATEGORY_KEYS = ['soundPercussion', 'soundThrowTones', 'soundButtons'];

/**
 * Small persisted-preferences store for the settings modal (see App's
 * openSettings/bindSettingsEvents) - one flat key/value bag, cached in
 * memory and mirrored to localStorage on every change so a reload picks up
 * where the player left off. Handed by reference to whatever else needs to
 * read a setting live (Renderer for backgroundEffect, Game for inputType)
 * rather than pushed through a subscription/event system - those just read
 * settings.get(key) fresh each time they need it (once per frame/input
 * event), which is simpler than keeping every consumer in sync with a
 * change notification, and cheap enough at this scale.
 */
export default class Settings {
    constructor() {
        this.values = { ...DEFAULT_SETTINGS, ...this.loadStored() };
    }

    /** Only keeps recognized keys with a currently-valid value - guards against a stale/differently-shaped blob from an earlier version. */
    loadStored() {
        try {
            const raw = window.localStorage?.getItem(STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            const result = {};
            for (const key of Object.keys(DEFAULT_SETTINGS)) {
                if (VALID_VALUES[key].includes(parsed[key])) result[key] = parsed[key];
            }
            // Migrate the old single soundEffects toggle, or the even older
            // standalone mute flag, to all three category toggles off.
            const hadSoundCategories = SOUND_CATEGORY_KEYS.some((key) => key in parsed);
            if (!hadSoundCategories) {
                const legacyMuted = parsed.soundEffects === 'off'
                    || window.localStorage?.getItem(LEGACY_MUTED_STORAGE_KEY) === '1';
                if (legacyMuted) {
                    for (const key of SOUND_CATEGORY_KEYS) result[key] = 'off';
                }
            }
            return result;
        } catch {
            return {}; // Malformed JSON, or storage access blocked (e.g. private browsing).
        }
    }

    get(key) {
        return this.values[key];
    }

    set(key, value) {
        this.values[key] = value;
        this.persist();
    }

    resetToDefaults() {
        this.values = { ...DEFAULT_SETTINGS };
        this.persist();
    }

    persist() {
        try {
            window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.values));
        } catch {
            // Private browsing etc - losing the preference on reload isn't worth failing over.
        }
    }
}
