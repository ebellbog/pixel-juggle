import { PATTERN_GROUPS, CUSTOM_PATTERN_VALUE, findPattern } from './patterns.js';

const STORAGE_KEY = 'pixel-juggle-pattern';

const DEFAULT_VALUE = PATTERN_GROUPS[0].patterns[0].value;

/**
 * Persisted title-screen pattern picker state (see App's setPatternValue/
 * validate) - which curated entry (or Custom) is selected, plus the custom
 * siteswap string when Custom is active. Loaded once into memory and
 * mirrored to localStorage on every change, same read/write-through shape
 * as Settings.js and Scores.js.
 */
export default class PatternSelection {
    constructor() {
        const stored = this.loadStored();
        this.value = stored.value;
        this.customSiteswap = stored.customSiteswap;
    }

    /** Keeps a recognized picker value and a string custom siteswap - guards against a stale/malformed blob. */
    loadStored() {
        try {
            const raw = window.localStorage?.getItem(STORAGE_KEY);
            if (!raw) return { value: DEFAULT_VALUE, customSiteswap: '' };

            const parsed = JSON.parse(raw);
            const value = typeof parsed.value === 'string' ? parsed.value : DEFAULT_VALUE;
            const customSiteswap = typeof parsed.customSiteswap === 'string' ? parsed.customSiteswap : '';

            if (value === CUSTOM_PATTERN_VALUE) {
                return { value: CUSTOM_PATTERN_VALUE, customSiteswap };
            }
            if (findPattern(value)) {
                return { value, customSiteswap };
            }
            return { value: DEFAULT_VALUE, customSiteswap: '' };
        } catch {
            return { value: DEFAULT_VALUE, customSiteswap: '' };
        }
    }

    getValue() {
        return this.value;
    }

    getCustomSiteswap() {
        return this.customSiteswap;
    }

    setValue(value) {
        this.value = value;
        this.persist();
    }

    setCustomSiteswap(siteswap) {
        this.customSiteswap = siteswap;
        this.persist();
    }

    persist() {
        try {
            window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
                value: this.value,
                customSiteswap: this.customSiteswap,
            }));
        } catch {
            // Private browsing etc - losing the preference on reload isn't worth failing over.
        }
    }
}
