const STORAGE_KEY = 'pixel-juggle-scores';

/**
 * Persisted competitive-mode score history (see Game's onGameOver/App's
 * handleGameOver) - one flat array of completed runs, mirrored to
 * localStorage on every change, in the same shape the leaderboard/game-over
 * tables already render (player/pattern/difficulty/score - see
 * templates/partials/score-table.handlebars). Modeled after Settings.js:
 * loaded once into memory, read/written synchronously, no change
 * notification - App just re-renders whichever modal is open after calling
 * add()/resetAll().
 */
export default class Scores {
    constructor() {
        this.entries = this.loadStored();
    }

    /** Drops anything that doesn't look like a real score row - guards against a stale/malformed blob from an earlier version. */
    loadStored() {
        try {
            const raw = window.localStorage?.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((entry) => entry
                && typeof entry.id === 'string'
                && typeof entry.player === 'string'
                && typeof entry.pattern === 'string'
                && typeof entry.difficulty === 'string'
                && Number.isFinite(entry.score));
        } catch {
            return []; // Malformed JSON, or storage access blocked (e.g. private browsing).
        }
    }

    getAll() {
        return this.entries;
    }

    /**
     * Appends one completed competitive run and persists it immediately.
     * Returns the stored entry (with its generated id) so the caller can
     * scroll to/highlight this exact row even though the table itself is
     * sorted, not append-ordered (see sortLeaderboardScores in App.js).
     */
    add({ player, pattern, difficulty, score }) {
        const entry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            player: (player || '').trim() || 'Player',
            pattern,
            difficulty,
            score,
        };
        this.entries.push(entry);
        this.persist();
        return entry;
    }

    resetAll() {
        this.entries = [];
        this.persist();
    }

    persist() {
        try {
            window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.entries));
        } catch {
            // Private browsing etc - losing history on reload isn't worth failing over.
        }
    }
}
