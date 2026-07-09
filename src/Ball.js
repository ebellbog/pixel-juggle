const PALETTE = [
    '#e6194b',
    '#3cb44b',
    '#4363d8',
    '#f58231',
    '#911eb4',
    '#42d4f4',
    '#f032e6',
    '#bfef45',
    '#fabed4',
    '#469990',
];

export default class Ball {
    constructor(id) {
        this.id = id;
        this.color = PALETTE[id % PALETTE.length];
        // Recent {time, x, y} samples of this ball's own path, oldest first.
        // Recorded while flying, and left untouched while resting in a hand,
        // so its trail persists smoothly across a catch instead of resetting
        // to empty the instant it lands (see JugglingSimulator.recordTrails).
        this.trail = [];
        // Internal-time timestamp this ball's trail was last sampled at, so
        // a newly recorded batch of dots can be spread evenly back to it
        // rather than clumped at the current instant (see
        // JugglingSimulator.recordTrails). -Infinity means "no previous
        // sample" - a fresh ball's first batch is just placed at the
        // current instant.
        this.lastTrailSampleTime = -Infinity;
        // How many seconds of history to keep, refreshed to match whichever
        // throw most recently launched this ball.
        this.trailWindow = 0;
    }
}
