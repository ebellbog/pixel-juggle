const PALETTE = [
    '#911eb4', // Purple
    '#f58231', // Orange
    '#42d4f4', // Cyan / Light Blue
    '#e6194b', // Red
    '#3cb44b', // Green
    '#4363d8', // Blue
    '#f032e6', // Magenta / Pink
    '#bfef45', // Lime / Light Green
    '#fabed4', // Pink / Light Pink
    '#469990', // Teal
];

export default class Ball {
    /** The color a ball with this id will have, before it necessarily exists yet - lets a not-yet-spawned ball's queue placeholder (see JugglingSimulator) show its real eventual color. */
    static colorFor(id) {
        return PALETTE[id % PALETTE.length];
    }

    constructor(id) {
        this.id = id;
        this.color = Ball.colorFor(id);
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
        // Velocity this ball is at rest with - {0, 0} for a ball that's never
        // been thrown, or whatever it landed with (see Throw.landVelocity)
        // once it has. Used as the next throw's incomingVelocity, so a ball
        // that's immediately re-thrown after landing carries its momentum
        // into the new carry curve instead of snapping to a dead stop (see
        // Game, which - unlike JugglingSimulator's per-hand tracking - needs
        // this on the ball itself since a hand's queue can hold several
        // balls at differing rest states at once).
        this.restVelocity = { x: 0, y: 0 };
    }
}
