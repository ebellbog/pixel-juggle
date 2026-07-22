import JugglingSimulator from './JugglingSimulator.js';
import Ball from './Ball.js';
import Throw from './Throw.js';
import KeyboardInput from './KeyboardInput.js';
import { queueSlotPosition, queueSlotIndexForRender, QUEUE_SPACING_RADII } from './HandQueue.js';
import { getAvailableHeights, computeLitRings, chargePastCancelThreshold, chargeInCancelFlash, chargeWedgeHidden } from './ThrowHeight.js';

const MAX_FRAME_DT = 0.1; // Clamp huge gaps (e.g. backgrounded tab).

// Match JugglingSimulator.resolveLandings - beat times and endTimes can differ
// by a floating-point hair even when they represent the same instant.
const LANDING_EPSILON = 1e-9;

// How long the wedge flashes green (throw fired) or red (beat cancel).
const BEAT_FLASH_MS = 180;

// Competitive mode only (see startGrooveCountdown): how many *beats* (not
// wall-clock seconds - see there for why) the player has to get back "in
// the groove" (a full clean period - see recordThrowSequenceOutcome) after
// a mistake, before it's game over. Indexed by (this.mistakeCount - 1),
// clamped to the last entry for every mistake past the first - escalating
// pressure over a run, rather than a single fixed grace window throughout
// (this.mistakeCount itself never resets on a successful recovery, only on
// a fresh restart - see resetState).
const GROOVE_COUNTDOWN_SCHEDULE_BEATS = [10, 5];

/**
 * Everything that happens once the player commits to "Let me try!": the
 * static ghost-path preview, plus letting the player actually throw balls.
 * Kept separate from App, which just owns the page's idle-state chrome (see
 * there).
 *
 * Exactly one *step* is highlighted at a time - whichever throw (or, for a
 * synchronous pattern's beat-pairs, pair of throws - see
 * buildThrowSequenceSteps) is next expected in the pattern's own order,
 * tracked independent of the live beat clock (see
 * throwSequenceIndex/recordThrowSequenceOutcome) rather than "whichever beat
 * this is," so starting a beat late or making one mistake doesn't just
 * permanently desync the cue from what the player is actually doing. Any
 * wrong throw, an attempt that fails outright (empty hand,
 * expired hold), or a catch landing on a hand that's still holding a ball
 * it's already thrown at least once before (see resolveLandings - these
 * patterns are never multiplexed, so that always means some earlier throw
 * got skipped) hides the highlight until a full clean period brings it
 * back - simply not
 * pressing anything is never itself held against the player, since there's
 * no fixed per-beat obligation here (see resolveBeatThrow). Before the
 * player's first-ever match nothing is held against them yet either way
 * (see throwSequenceStarted), so the initial highlight just waits for them
 * rather than disappearing first.
 *
 * Manual throws reuse the exact same Throw geometry as the scripted "Show
 * me" demo (via `this.physics`, a JugglingSimulator instance kept around
 * purely as a source of fixed constants - hand positions, arcPeakFor,
 * carryDuration, etc - never ticked or fed a schedule), so a player-thrown
 * ball's recoil-scoop-launch motion looks identical to the automatic one.
 *
 * Each hand holds a horizontal queue of balls (see this.queues): index 0 is
 * the "innermost" ball, next in line to throw, and sits exactly at that
 * hand's catch position - the same spot Throw's carry curve starts from -
 * so throwing it never has to jump it into place first. Catching adds to
 * the far ("outermost") end; throwing removes from the near end. Only the
 * innermost ball's position ever matters for continuity; the rest of the
 * queue is purely cosmetic bookkeeping (see queuePosition).
 *
 * Throw height is chosen by how long the throw button is held within the
 * charge window (see ThrowHeight.CHARGE_WINDOW_FRACTION and this.charging):
 * releasing inside that window locks the height (yellow wedge) and the throw
 * fires on the next beat; holding without releasing fires on the beat only if
 * the window hasn't expired yet (white wedge). Past the window, release or
 * beat both cancel. On the beat, a successful throw flashes green; an empty
 * hand or cancelled attempt flashes red. Each beat attempt requires a fresh
 * key press afterward; pressing while yellow resets to a fresh charge.
 *
 * Both hands' wedges stay on screen at all times (see buildWedgeState), not
 * just while charging, so the player can watch them ahead of a press. Each
 * also shows a target-ball indicator at its vertex (see computeTargetState/
 * Renderer.drawThrowHeightWedge): a dotted outline if this hand has no ball
 * and none will land in time for the very next beat, or a filled circle in
 * that ball's color once one is either already queued or about to land.
 * Pressing the throw button with no valid target shows a red danger state
 * on that wedge for as long as the key stays held (see dangerHold), rather
 * than starting a charge that could never succeed.
 *
 * Every beat also ticks this.soundtrack (see Soundtrack) once, every manual
 * throw fires off a fading tone through it, and every additional ring lit
 * on an in-progress charge fires off a rising tick (see updateChargeTicks).
 * Unlike the demo, which
 * steps the soundtrack's chord progression on a plain beat count (see
 * JugglingSimulator.processBeat), here it's driven entirely by the
 * player's own accuracy instead (see soundtrackSuccessCount/
 * recordThrowSequenceOutcome) - correct throws advance it, a mismatch
 * resets it. That, plus onBeat/executeThrow's calls into it, is the
 * entirety of this class's involvement with sound; the actual synthesis
 * lives there.
 */
export default class Game {
    constructor(siteswap, {
        bpm, renderer, $beatBar, $beatBarWrap, $streakValue, $maxStreakValue, soundtrack, settings,
        // Competitive mode (easier/normal/harder - as opposed to practice,
        // the only mode before this - see App.DIFFICULTY_CONFIG) swaps the
        // streak/best HUD for a single score stat, ramps BPM on its own
        // rather than the (hidden) slider, and can end the run outright -
        // see updateStatsDisplay/recordThrowSequenceOutcome/
        // startGrooveCountdown/triggerGameOver, all gated on isCompetitive.
        // Every param below this line is competitive-only; practice mode
        // leaves them all at their defaults and never touches the state
        // they'd drive.
        mode = 'practice',
        difficultyConfig = null, // { label, startBpm, bpmIncrement }
        $scoreValue = null,
        $grooveCountdown = null,
        $grooveCountdownValue = null,
        onGameOver = null, // ({ score }) => void - called once, after this.stop() has already run.
    }) {
        this.renderer = renderer;
        this.$beatBar = $beatBar;
        this.$beatBarWrap = $beatBarWrap;
        this.$streakValue = $streakValue;
        this.$maxStreakValue = $maxStreakValue;
        this.isCompetitive = mode === 'competitive';
        this.difficultyConfig = difficultyConfig;
        this.$scoreValue = $scoreValue;
        this.$grooveCountdown = $grooveCountdown;
        this.$grooveCountdownValue = $grooveCountdownValue;
        this.onGameOver = onGameOver;
        // A percussive tick per beat and a fading tone per manual throw -
        // see onBeat/executeThrow below and Soundtrack itself. Always
        // present (App hands over a real instance), and every one of its
        // public methods is already a safe no-op on its own if Web Audio
        // isn't available, so there's nothing to null-check here.
        this.soundtrack = soundtrack;
        // Player's inputType preference (see Settings.js) - read fresh on
        // every press (see isTapMode/handleThrowStart) rather than cached,
        // so switching modes from the settings modal mid-game takes effect
        // on the very next press rather than needing a restart.
        this.settings = settings;
        // Only read for isSync (see ThrowHeight.getAvailableHeights/
        // buildWedgeState) - sync's wedge ladders and labels work
        // differently than vanilla's (every height is even; crossing is an
        // explicit 'x' rather than implied by odd/even).
        this.isSync = siteswap.isSync;

        // Never ticked with update()/processBeat() as a schedule - only read
        // for its fixed constants (hands.*.outerX/innerX, arcPeakFor,
        // beatDuration, carryDuration, carryLift, handY, ballRadius,
        // timeScale) and, via getGhostPaths(), the practice-mode preview.
        // setBpm() is still called on it (see setBpm below) purely to keep
        // its timeScale in sync, since manual throws borrow that too.
        this.physics = new JugglingSimulator(siteswap, { bpm });
        // Chronologically ordered - one full period of the pattern's own
        // scripted throws, tagged with hand/crossing/height (see
        // JugglingSimulator.getGhostPaths) - doubles as both the ghost-path
        // geometry to render and the sequence Game's own throws are checked
        // against (see throwSequenceIndex below).
        this.paths = this.physics.getGhostPaths();
        this.period = this.physics.period;
        this.ballRadius = this.physics.ballRadius;
        this.extent = this.buildExtent();

        // this.paths grouped by beat, so a synchronous pattern's beat-pairs
        // (both hands throwing at once - see SyncSiteswap) are tracked and
        // highlighted as one atomic step rather than two throws in a row.
        // For an async pattern every step is just a single throw, so this
        // degrades to the same one-at-a-time behavior as before (see
        // buildThrowSequenceSteps/recordThrowSequenceOutcome).
        this.throwSequenceSteps = this.buildThrowSequenceSteps();
        // The two height "ladders" (crossing: odd, self: even) a held throw
        // can select from, capped at whatever this pattern's tallest throw
        // is - see ThrowHeight and this.charging below.
        const { crossHeights, selfHeights } = getAvailableHeights(this.physics.getMaxHeight(), { sync: this.isSync });
        this.crossHeights = crossHeights;
        this.selfHeights = selfHeights;

        // Best consecutive correct throws this "Let me try!" session -
        // survives restart() (see there) but resets when App tears down
        // and recreates Game on a fresh startGame() call.
        this.maxStreak = 0;

        // Everything below is runtime state that a restart (see resetState/
        // restart) puts back to its just-constructed values, as opposed to
        // the pattern-derived, never-changing setup above.
        this.resetState();

        this.inputSchemes = [new KeyboardInput({
            onThrowStart: (intent) => this.handleThrowStart(intent),
            onThrowRelease: (intent) => this.handleThrowRelease(intent),
        })];

        this.rafId = null;
    }

    /**
     * (Re)initializes every piece of state that actually changes over the
     * course of play - as opposed to the fixed, pattern-derived setup in
     * the constructor above it (this.physics, this.paths,
     * this.throwSequenceSteps, this.crossHeights/selfHeights, etc), which
     * never needs to be touched again. Called once from the constructor,
     * and again from restart() to put the player right back at the
     * beginning without tearing down and recreating the whole Game (which
     * would mean detaching and reattaching input schemes, losing the
     * render/tick loop, etc).
     */
    resetState() {
        // Tracks progress through this.throwSequenceSteps, independent of
        // the live beat clock - so an off-tempo start or a mistake doesn't
        // just cosmetically desync the ghost highlight for the rest of the
        // run (see recordThrowSequenceOutcome/resolveBeatThrow). Index of
        // the next expected step; advances only once every hand due to
        // throw in that step has matched (see throwSequencePending).
        this.throwSequenceIndex = 0;
        // Which of the current step's hands still haven't thrown correctly
        // yet - reset to that step's full hand set whenever the pointer
        // advances. A sync step starts with both hands pending and only
        // advances once both have gone through; an async step always has
        // exactly one.
        this.throwSequencePending = new Set(this.throwSequenceSteps[0].entries.map((entry) => entry.hand));
        // Consecutive correct throws since the last mismatch - highlighting
        // resumes once this reaches a full period (this.paths.length).
        this.throwSequenceStreak = 0;
        // True once a mismatch (a wrong throw, or an attempt that failed
        // outright) has hidden the ghost highlight; cleared only by a full
        // clean period (see recordThrowSequenceOutcome).
        this.throwSequenceHidden = false;
        // False until the player has landed the very first expected throw -
        // nothing is held against them before that (see
        // recordThrowSequenceOutcome), so the initial highlight just waits,
        // untouched by wrong or failed attempts, until they actually hit it
        // once.
        this.throwSequenceStarted = false;
        // Consecutive correct throws since the last mismatch *or* the last
        // chord change - unlike throwSequenceStreak (which tracks the ghost
        // highlight and never resets on a good run), this one resets to 0
        // every time it reaches physics.effectivePeriodForMusic, stepping
        // the soundtrack's chord progression each time it does (see
        // recordThrowSequenceOutcome) - so, unlike the demo's plain beat
        // count (see JugglingSimulator.processBeat), the chord in "let me
        // try" only ever advances on the player's own successful throws,
        // and a mismatch resets it back to the first chord rather than
        // letting it silently keep climbing through failures.
        this.soundtrackSuccessCount = 0;

        // Beat bar and ghost-path highlight are driven off this one clock,
        // so dragging the BPM slider can't leave them out of sync with each
        // other (see draw/tick). Independent of manual throw timing below -
        // the whole point of the cue is to show the *target* beat, which the
        // player is free to miss.
        this.beatIndex = 0;
        // Next beat boundary in simulation time (reference-tempo seconds). Kept
        // in lockstep with this.time so landings resolve before beat throws -
        // see tick(), mirroring JugglingSimulator.update().
        this.nextBeatTime = this.physics.beatDuration;

        // Simulation time for manually-thrown balls, in the same
        // reference-tempo seconds as this.physics (see JugglingSimulator's
        // own time/timeScale) - advanced the same way in tick(), so a throw
        // triggered right now plays out at exactly the tempo the rest of the
        // app agrees on.
        this.time = 0;
        this.inFlight = [];
        this.queues = this.buildInitialQueues();
        // Per-hand inward-shift window for the live queue - set when the
        // innermost ball is thrown (executeThrow) and read when laying
        // out the queue (draw).
        this.queueShiftStart = { L: -Infinity, R: -Infinity };
        this.queueShiftUntil = { L: -Infinity, R: -Infinity };
        // Per-hand height locked on release, waiting for the next beat (see
        // handleThrowRelease/resolveBeatThrow) - { crossing, height, litRings }.
        this.lockedThrow = { L: null, R: null };
        // Per-hand in-progress button hold - { crossing, startWallTime } or
        // null (see handleThrowStart/handleThrowRelease/getChargeState).
        this.charging = { L: null, R: null };
        // Per-hand ring count already ticked for the in-progress charge (see
        // updateChargeTicks) - lets that method play exactly one rising tick
        // each time the charge's own lit-ring count goes up, rather than
        // once per frame.
        this.chargeTickRings = { L: 0, R: 0 };
        // Brief green/red wedge flash after a beat-boundary throw attempt -
        // { color, wallTime, crossing, litRings } or null.
        this.beatFlash = { L: null, R: null };
        // Per-hand red danger hold when the throw key is down but no ball is
        // targeted - { crossing } or null (see handleThrowStart/Release).
        this.dangerHold = { L: null, R: null };

        // Competitive mode only - see the constructor's doc comment.
        // this.mistakeCount deliberately isn't reset by a mid-run recovery
        // (see recordThrowSequenceOutcome/startGrooveCountdown) - only a
        // fresh restart/new game resets the escalating grace-window
        // schedule back to its most forgiving entry. BPM is reset back to
        // the difficulty's own starting tempo here too, since a restart
        // should also undo whatever ramping (see the chord-progression
        // branch in recordThrowSequenceOutcome) happened before it.
        if (this.isCompetitive) {
            this.score = 0;
            this.mistakeCount = 0;
            this.grooveCountdownActive = false;
            this.grooveDeadline = null;
            this.grooveDisplayedBeat = null;
            this.gameOverTriggered = false;
            if (this.difficultyConfig) this.setBpm(this.difficultyConfig.startBpm);
            if (this.$grooveCountdown) this.$grooveCountdown.addClass('hidden');
        }

        this.lastTimestamp = performance.now();
        this.updateStatsDisplay();
    }

    /** Refreshes the top-center HUD - streak/best for practice, or the single larger score stat for competitive (see App's #game-stats). */
    updateStatsDisplay() {
        if (this.isCompetitive) {
            if (this.$scoreValue) this.$scoreValue.text(this.score);
            return;
        }
        if (this.$streakValue) this.$streakValue.text(this.throwSequenceStreak);
        if (this.$maxStreakValue) this.$maxStreakValue.text(this.maxStreak);
    }

    /**
     * Puts every ball back in its starting hand and the beat clock back to
     * zero, without otherwise disturbing the running game (input stays
     * attached, the render/tick loop keeps going) - lets the player jump
     * right back to a clean attempt instead of stopping and re-launching
     * "Let me try!" from App. A held-down throw key physically stays held
     * through the restart, but since KeyboardInput only reports a fresh
     * press once its key has actually been released (see keysHeld there),
     * that's inert here - nothing further fires until the player lets go
     * and presses again.
     */
    restart() {
        this.resetState();
        this.soundtrack.stopAll();
        this.renderer.resetIntensity();
        this.$beatBar.css('transform', 'scaleX(1)');
        this.draw();
    }

    /**
     * Groups this.paths into chronological steps - runs of consecutive
     * entries sharing the same `beat` (paths already come back in that
     * order, R-before-L within a beat - see JugglingSimulator.getGhostPaths).
     * An async pattern never has two hands on the same beat, so every step
     * here is trivially just one throw; a synchronous pattern's beat-pairs
     * group into a single two-throw step instead, so the tracker below
     * waits for both hands before advancing rather than treating them as
     * two throws in a row.
     */
    buildThrowSequenceSteps() {
        const steps = [];
        for (const path of this.paths) {
            const current = steps[steps.length - 1];
            if (current && current.beat === path.beat) {
                current.entries.push(path);
            } else {
                steps.push({ beat: path.beat, entries: [path] });
            }
        }
        return steps;
    }

    /**
     * Deals the pattern's balls into the hands' starting queues via
     * this.physics.spawnOrder - the exact same hand assignment "Show me"
     * uses to feed balls into the pattern one at a time as it establishes
     * itself (see JugglingSimulator's computeSpawnOrder) - rather than a
     * separate, simpler round-robin here that could disagree with it (e.g.
     * a shower like "51" needs two balls in one hand and one in the other,
     * not an even split). spawnOrder is already in throw order for each
     * hand, so pushing straight through also gets queue depth right: the
     * first ball spawnOrder assigns to a given hand ends up innermost
     * (index 0, next to throw - see this.queues' own header comment)
     * simply because it's pushed first.
     */
    buildInitialQueues() {
        const queues = { L: [], R: [] };
        this.physics.spawnOrder.forEach((hand, id) => {
            queues[hand].push(new Ball(id));
        });
        return queues;
    }

    /**
     * Widens JugglingSimulator's own getExtent() to also fit a queue's
     * horizontal spread. Sized for the worst case - every ball crossed into
     * one hand and never crossed back - rather than just the starting
     * layout, since queue length can grow past its initial split during
     * play (see handleThrowInput).
     */
    buildExtent() {
        // JugglingSimulator's own spawn-queue allowance (see its getExtent)
        // is exact but schedule-bound - only ever as deep as the pattern's
        // fixed warm-up requires. Ours has to cover whatever the player does
        // (see handleThrowInput's comment on worst-case queue growth), which
        // can exceed that, so it's computed separately here rather than
        // reusing that term.
        const base = this.physics.getExtent({ includeSpawnQueue: false });
        const maxPossibleQueueLen = Math.max(1, this.physics.numBalls);
        const extraWidth = this.ballRadius * QUEUE_SPACING_RADII * (maxPossibleQueueLen - 1);
        return {
            minX: base.minX - extraWidth,
            maxX: base.maxX + extraWidth,
            minY: base.minY,
            maxY: base.maxY,
        };
    }

    start() {
        this.renderer.resetIntensity();
        this.renderer.fit(this.extent);
        this.$beatBar.css('transform', 'scaleX(1)');
        this.$beatBarWrap.removeClass('hidden');

        for (const scheme of this.inputSchemes) scheme.attach();

        this.lastTimestamp = performance.now();
        this.draw();
        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    setBpm(bpm) {
        // Keeps this.physics.timeScale current - both the beat cue and any
        // in-progress charge's timing (see getChargeState) read tempo
        // through it.
        this.physics.setBpm(bpm);
    }

    /** True when the player's inputType preference (see Settings.js) is 'tap' rather than the default 'hold'. */
    isTapMode() {
        return this.settings?.get('inputType') === 'tap';
    }

    /**
     * Starts charging a throw for `hand` (hold mode), or advances its
     * cycle by one ring (tap mode - see handleTapThrow) - either way,
     * dispatched fresh on every physical press (KeyboardInput already
     * filters out OS key-repeat while a key stays held - see there), so
     * switching modes between presses just changes which of the two this
     * routes to. If a yellow locked throw is already waiting on this hand,
     * pressing again in hold mode clears it and starts fresh from the
     * lowest height. If this hand has no ball queued and none will land in
     * time for the throw to resolve (see computeTargetState), there's
     * nothing to throw even in principle, so the wedge shows red for as
     * long as the key stays held (see dangerHold) instead of charging up
     * to a throw that's certain to fail.
     */
    handleThrowStart({ hand, crossing }) {
        if (this.isTapMode()) {
            this.handleTapThrow(hand, crossing);
            return;
        }

        if (this.lockedThrow[hand]) this.lockedThrow[hand] = null;
        if (this.charging[hand]) return;
        const heights = crossing ? this.crossHeights : this.selfHeights;
        if (heights.length === 0) return;

        if (!this.computeTargetState(hand).valid) {
            this.dangerHold[hand] = { crossing };
            return;
        }

        this.dangerHold[hand] = null;
        this.charging[hand] = { crossing, startWallTime: performance.now() };
    }

    /**
     * Tap mode's alternative to the hold-to-charge flow above: rather than
     * opening a timed charge window, each press immediately locks in a
     * height, waiting for the next beat exactly like a released hold does
     * (see resolveBeatThrow) - there's no charging/timing state at all in
     * this mode, so getChargeState/updateChargeTicks simply never see this
     * hand active (this.charging stays untouched). Pressing again on the
     * same hand and side before that throw fires advances the locked
     * height by one ring, wrapping back to the first ring once the
     * ladder's top is passed; pressing the *other* side, or pressing after
     * this hand's previous throw already fired, starts fresh at the first
     * ring instead - the same "fresh press always starts over" rule hold
     * mode's handleThrowStart applies to its own charge.
     */
    handleTapThrow(hand, crossing) {
        const heights = crossing ? this.crossHeights : this.selfHeights;
        if (heights.length === 0) return;

        if (!this.computeTargetState(hand).valid) {
            this.dangerHold[hand] = { crossing };
            this.lockedThrow[hand] = null;
            return;
        }

        this.dangerHold[hand] = null;
        const existing = this.lockedThrow[hand];
        const litRings = existing && existing.crossing === crossing
            ? (existing.litRings % heights.length) + 1
            : 1;
        this.lockedThrow[hand] = { crossing, height: heights[litRings - 1], litRings };
        this.soundtrack.playChargeTick(litRings);
        this.draw();
    }

    /**
     * Which ball (if any) `hand`'s next throw would send flying: the
     * innermost queued ball if it's already holding one, or - if not - the
     * soonest-landing in-flight ball destined for it, but only if that
     * landing arrives by the very next beat boundary (this.nextBeatTime),
     * i.e. in time for a throw started right now to actually resolve. Used
     * both for the wedge's target indicator (see Renderer) and to reject a
     * throw attempt immediately when there's no such ball (see
     * handleThrowStart).
     */
    computeTargetState(hand) {
        if (this.queues[hand].length > 0) {
            return { valid: true, color: this.queues[hand][0].color };
        }
        let soonest = null;
        for (const entry of this.inFlight) {
            if (entry.destHand !== hand) continue;
            if (entry.flight.endTime > this.nextBeatTime + LANDING_EPSILON) continue;
            if (!soonest || entry.flight.endTime < soonest.flight.endTime) soonest = entry;
        }
        return soonest ? { valid: true, color: soonest.ball.color } : { valid: false, color: null };
    }

    /**
     * Timing state for an in-progress charge: how many rings are lit,
     * whether the hold has crossed the charge window (cancel on release), whether
     * we're in the brief red-flash window, and whether the wedge is hidden.
     */
    getChargeState(hand) {
        const charge = this.charging[hand];
        if (!charge) return null;
        const heights = charge.crossing ? this.crossHeights : this.selfHeights;
        const elapsedSeconds = (performance.now() - charge.startWallTime) / 1000;
        const beatDurationSeconds = 60 / this.physics.bpm;
        return {
            litRings: computeLitRings(heights.length, elapsedSeconds, beatDurationSeconds),
            cancelled: chargePastCancelThreshold(elapsedSeconds, beatDurationSeconds),
            cancelFlash: chargeInCancelFlash(elapsedSeconds, beatDurationSeconds),
            wedgeHidden: chargeWedgeHidden(elapsedSeconds, beatDurationSeconds),
        };
    }

    /**
     * One rising soundtrack tick (see Soundtrack.playChargeTick) per
     * additional ring lit on each hand's in-progress charge, including the
     * very first ring the instant a charge starts - called every frame
     * (see tick()) and compared against chargeTickRings rather than fired
     * straight from handleThrowStart/getChargeState, so it stays correct
     * even if a single frame's charge-window math jumps across more than
     * one ring at once (a hitch, or very few rings on a fast beat). Resets
     * back to 0 the instant a hand isn't charging, so the next fresh press
     * starts from ring 1 again.
     */
    updateChargeTicks() {
        for (const hand of ['L', 'R']) {
            if (!this.charging[hand]) {
                this.chargeTickRings[hand] = 0;
                continue;
            }
            const litRings = this.getChargeState(hand).litRings;
            for (let ring = this.chargeTickRings[hand] + 1; ring <= litRings; ring++) {
                this.soundtrack.playChargeTick(ring);
            }
            this.chargeTickRings[hand] = litRings;
        }
    }

    /** Locks in height on release (yellow wedge), or clears a danger hold. */
    handleThrowRelease({ hand, crossing }) {
        const danger = this.dangerHold[hand];
        if (danger && danger.crossing === crossing) {
            this.dangerHold[hand] = null;
            this.draw();
            return;
        }

        const charge = this.charging[hand];
        if (!charge || charge.crossing !== crossing) return;
        const state = this.getChargeState(hand);
        this.charging[hand] = null;
        if (state.cancelled) {
            this.draw();
            return;
        }
        const heights = crossing ? this.crossHeights : this.selfHeights;
        const height = heights[state.litRings - 1];
        this.lockedThrow[hand] = { crossing, height, litRings: state.litRings };
        this.draw();
    }

    /** Fires or cancels beat-boundary throws for both locked (yellow) and held (white) hands. */
    onBeat() {
        this.soundtrack.playBeat(60 / this.physics.bpm);
        for (const hand of ['L', 'R']) {
            this.resolveBeatThrow(hand);
        }
    }

    /**
     * At the beat: throw if this hand has a yellow lock or a white hold that
     * hasn't expired. Green flash + execute when the queue has a ball; red
     * flash + cancel on an empty hand or an expired hold. A white hold is
     * cleared after the beat so the key must be released and pressed again
     * before the next attempt; a yellow lock is always consumed on the beat.
     *
     * If neither is present, this hand simply didn't attempt anything this
     * beat - not held against the player (see decoupling in
     * recordThrowSequenceOutcome). There's no fixed per-beat obligation in
     * this game (a hand can sit on a ball as long as the player likes), so
     * idle beats with no press at all aren't treated as misses - only a
     * throw that's actually attempted and fails (empty hand, expired hold,
     * or the wrong hand/crossing/height) breaks the ghost-highlight streak.
     */
    resolveBeatThrow(hand) {
        const locked = this.lockedThrow[hand];
        const charge = this.charging[hand];
        if (!locked && !charge) {
            return;
        }

        let crossing;
        let height;
        let litRings;
        let fromLock = false;

        if (locked) {
            ({ crossing, height, litRings } = locked);
            fromLock = true;
        } else {
            const state = this.getChargeState(hand);
            const heights = charge.crossing ? this.crossHeights : this.selfHeights;
            crossing = charge.crossing;
            litRings = state.litRings;
            height = heights[litRings - 1];

            if (state.cancelled) {
                this.beatFlash[hand] = {
                    color: 'red',
                    wallTime: performance.now(),
                    crossing,
                    litRings,
                };
                this.charging[hand] = null;
                this.recordThrowSequenceOutcome(null, crossing, height);
                return;
            }
        }

        const success = this.handHasThrowableBall(hand);
        this.beatFlash[hand] = {
            color: success ? 'green' : 'red',
            wallTime: performance.now(),
            crossing,
            litRings,
        };

        if (fromLock) {
            this.lockedThrow[hand] = null;
        } else {
            // Key may still be physically held - clearing charge ensures the
            // next beat won't fire again until a fresh press (see
            // KeyboardInput.keysHeld).
            this.charging[hand] = null;
        }

        if (success) {
            this.executeThrow(hand, crossing, height);
        }
        this.recordThrowSequenceOutcome(success ? hand : null, crossing, height);
    }

    /**
     * Advances (or breaks) progress through the pattern's own scripted throw
     * order (see this.paths/throwSequenceIndex) given the outcome of one
     * hand's beat-boundary throw attempt (or, from resolveLandings, a catch
     * that reveals an earlier throw never happened at all). `hand` is null
     * for anything that isn't an actual successful throw - an empty-hand
     * cancel, an expired hold, or an unthrown ball getting caught on top of
     * - which always counts as a mismatch, same as a throw that did fire
     * but with the wrong hand/crossing/height for what's next expected.
     *
     * On a mismatch, the streak resets and the highlight hides, but the
     * pointer itself doesn't move - it keeps waiting for that same expected
     * step, so the very next correct throw already starts real recovery
     * rather than being compared against whatever came after the miss (and,
     * for a synchronous step, a hand that already matched this step stays
     * matched - only the still-pending hand(s) are re-evaluated). Before the
     * player's first-ever match, though, mismatches are ignored outright
     * (see throwSequenceStarted) - there's nothing to recover from yet, so
     * the initial highlight just keeps waiting for them to get to it, rather
     * than hiding before they've had a real chance to start.
     *
     * Also drives the soundtrack's chord progression (see
     * soundtrackSuccessCount/Soundtrack.advancePeriod): every match nudges
     * it toward the next chord, and every real mismatch snaps it straight
     * back to the first one - same start-only gating as the ghost highlight
     * above, so fumbling before the player's first correct throw doesn't
     * reset anything that hasn't started progressing yet.
     */
    recordThrowSequenceOutcome(hand, crossing, height) {
        const step = this.throwSequenceSteps[this.throwSequenceIndex];
        const expected = hand !== null ? step.entries.find((entry) => entry.hand === hand) : null;
        const matched = expected
            && this.throwSequencePending.has(hand)
            && expected.crossing === crossing
            && expected.height === height;

        if (matched) {
            this.throwSequenceStarted = true;
            this.throwSequencePending.delete(hand);
            this.throwSequenceStreak += 1;
            if (this.throwSequenceStreak > this.maxStreak) {
                this.maxStreak = this.throwSequenceStreak;
            }
            // Competitive mode: +1 per correct throw, no cap/reset - see
            // the constructor's doc comment. Practice's streak/best above
            // still track independently either way (they're just not
            // displayed - see updateStatsDisplay), so nothing here needs
            // its own mode check beyond this one line.
            if (this.isCompetitive) this.score += 1;
            this.updateStatsDisplay();
            if (this.throwSequenceStreak >= this.paths.length) {
                this.throwSequenceHidden = false;
                // Ghost highlight is back on - the player's "back in the
                // groove" (see class doc/startGrooveCountdown), so whatever
                // countdown a recent mistake started is called off.
                if (this.isCompetitive) this.clearGrooveCountdown();
            }
            if (this.throwSequencePending.size === 0) {
                this.throwSequenceIndex = (this.throwSequenceIndex + 1) % this.throwSequenceSteps.length;
                const nextStep = this.throwSequenceSteps[this.throwSequenceIndex];
                this.throwSequencePending = new Set(nextStep.entries.map((entry) => entry.hand));
            }
            this.soundtrackSuccessCount += 1;
            if (this.soundtrackSuccessCount >= this.physics.effectivePeriodForMusic) {
                this.soundtrackSuccessCount = 0;
                // Competitive mode: tempo ramps once the whole *sequence*
                // of chords has looped back to its first one (see
                // Soundtrack.advancePeriod's return value), not on every
                // single step within it - a step happens every period,
                // but a full lap is PROGRESSION.length periods.
                const completedChordLap = this.soundtrack.advancePeriod();
                if (this.isCompetitive && this.difficultyConfig && completedChordLap) {
                    this.setBpm(this.physics.bpm + this.difficultyConfig.bpmIncrement);
                }
            }
        } else if (this.throwSequenceStarted) {
            this.throwSequenceStreak = 0;
            this.updateStatsDisplay();
            // Only a *fresh* mismatch - the transition from "in the groove"
            // to not - starts a new countdown; repeated mismatches while
            // one's already running (this.throwSequenceHidden already
            // true) must not keep pushing the deadline back out (see
            // startGrooveCountdown).
            if (this.isCompetitive && !this.throwSequenceHidden) {
                this.startGrooveCountdown();
            }
            this.throwSequenceHidden = true;
            this.soundtrackSuccessCount = 0;
            this.soundtrack.resetProgression();
        }
    }

    /**
     * Competitive mode only: starts (or restarts, on top of an already-
     * active one - see the guard in recordThrowSequenceOutcome's caller)
     * the "get back in the groove" grace window after a mistake. Its
     * length comes off GROOVE_COUNTDOWN_SCHEDULE_BEATS, indexed by how
     * many mistakes this run has had so far, including this one -
     * escalating pressure over a run rather than one fixed window
     * throughout.
     *
     * Deliberately paced in *beats*, not wall-clock seconds: the schedule
     * is a beat count, converted to real milliseconds via this.physics.bpm
     * at the instant the mistake happens, so the grace window is exactly
     * as long as that many beats at whatever tempo is currently live - the
     * faster the game, the faster (in real time) the countdown runs, same
     * as everything else here. bpm can't itself change again before this
     * window ends (competitive's own ramp only fires on a clean full lap
     * of the chord progression - see recordThrowSequenceOutcome - which
     * can't happen while a mismatch is still unresolved), so one
     * beats-to-ms conversion up front is exact for the window's whole
     * duration, not just its start. Actually ticked down in
     * updateGrooveCountdown (see tick()), not here - this just marks the
     * deadline.
     */
    startGrooveCountdown() {
        this.mistakeCount += 1;
        const scheduleIndex = Math.min(this.mistakeCount, GROOVE_COUNTDOWN_SCHEDULE_BEATS.length) - 1;
        const beats = GROOVE_COUNTDOWN_SCHEDULE_BEATS[scheduleIndex];
        this.grooveBeatDurationMs = (60 / this.physics.bpm) * 1000;
        this.grooveCountdownActive = true;
        this.grooveDeadline = performance.now() + beats * this.grooveBeatDurationMs;
        this.grooveDisplayedBeat = null;
    }

    /** Cancels an in-progress grace window - the player recovered in time. */
    clearGrooveCountdown() {
        if (!this.grooveCountdownActive) return;
        this.grooveCountdownActive = false;
        this.grooveDeadline = null;
        this.grooveDisplayedBeat = null;
        if (this.$grooveCountdown) this.$grooveCountdown.addClass('hidden');
    }

    /**
     * Ticks the active grace window (see tick()): ends the run once its
     * deadline passes, otherwise keeps the big red numeral in sync with
     * however many whole beats (see startGrooveCountdown for why beats,
     * not seconds) remain, only touching the DOM (and restarting its pop
     * animation - see index.less' .groove-countdown-pop) on the beat it
     * actually changes rather than every frame.
     */
    updateGrooveCountdown() {
        if (!this.grooveCountdownActive) return;
        const remainingMs = this.grooveDeadline - performance.now();
        if (remainingMs <= 0) {
            this.triggerGameOver();
            return;
        }
        const beatsLeft = Math.ceil(remainingMs / this.grooveBeatDurationMs);
        if (beatsLeft === this.grooveDisplayedBeat) return;
        this.grooveDisplayedBeat = beatsLeft;
        if (!this.$grooveCountdown || !this.$grooveCountdownValue) return;
        this.$grooveCountdown.removeClass('hidden');
        this.$grooveCountdownValue.text(beatsLeft);
        const el = this.$grooveCountdownValue[0];
        el.classList.remove('groove-countdown-pop');
        void el.offsetWidth; // Force reflow so re-adding the class below restarts the animation.
        el.classList.add('groove-countdown-pop');
    }

    /**
     * Ends a competitive run: stops ticking/input, then hands the final
     * score up to App (see onGameOver) to run the game-over transition/
     * modal. `hideHud: false` (see stop()) leaves the beat bar/groove
     * countdown showing exactly as they were the instant this fired -
     * mode is still 'game' here, #canvas-area (their parent) hasn't
     * started fading yet, so snapping them to display:none right now
     * would flash them away well before any of App's staged fades even
     * begin. They fade out later, together with the rest of #canvas-area's
     * own opacity transition, and only actually get hidden once App tears
     * this Game instance down for real (see App.returnToMenuAfterGameOver/
     * clearSession, which calls stop() again with its default hideHud:
     * true - harmless by then, since #canvas-area is already invisible).
     */
    triggerGameOver() {
        if (this.gameOverTriggered) return;
        this.gameOverTriggered = true;
        const finalScore = this.score;
        this.stop({ hideHud: false });
        if (this.onGameOver) this.onGameOver({ score: finalScore });
    }

    /** Whether this hand can throw on the beat - queue nonempty, or a ball landing now. */
    handHasThrowableBall(hand) {
        this.resolveLandings(this.time + LANDING_EPSILON);
        return this.queues[hand].length > 0;
    }

    expireBeatFlashes() {
        const now = performance.now();
        for (const hand of ['L', 'R']) {
            const flash = this.beatFlash[hand];
            if (flash && now - flash.wallTime > BEAT_FLASH_MS) {
                this.beatFlash[hand] = null;
            }
        }
    }

    /**
     * Throws the innermost ball in `hand`'s queue, identically to a scripted
     * throw: same carry-then-flight geometry, same rest-velocity-matching
     * (whatever it landed with if it's fresh off a catch - see
     * Ball.restVelocity, or the pattern's steady-state landing velocity for
     * a never-flown ball - see getSteadyStateIncoming) so the carry curve
     * continues smoothly and first throws match the ghost paths.
     */
    executeThrow(hand, crossing, height) {
        const queue = this.queues[hand];
        if (queue.length === 0) return;

        const hadQueueBehind = queue.length > 1;
        const ball = queue.shift();
        ball.everThrown = true;
        if (hadQueueBehind) {
            this.queueShiftStart[hand] = this.time;
            this.queueShiftUntil[hand] = this.time + this.physics.carryDuration;
        }
        const destHand = crossing ? this.physics.otherHand(hand) : hand;
        const p = this.physics;

        const incomingVelocity = this.resolveIncomingVelocity(ball, hand, height);

        const flight = new Throw({
            ball,
            startTime: this.time,
            endTime: this.time + height * p.beatDuration,
            catchX: p.hands[hand].outerX,
            releaseX: p.hands[hand].innerX,
            landX: p.hands[destHand].outerX,
            baseY: p.handY,
            arcPeak: p.arcPeakFor(height),
            carryDuration: p.carryDuration,
            carryLift: p.carryLift,
            incomingVelocity,
        });

        this.inFlight.push({ flight, ball, destHand, sourceHand: hand });

        // Real-world seconds until this ball is caught again, at whatever
        // tempo is live right now - see the matching comment in
        // JugglingSimulator.executeThrow.
        const durationSeconds = (height * 60) / p.bpm;
        this.soundtrack.playThrow({ hand, height, durationSeconds });
    }

    /**
     * What incoming velocity the next carry from `hand` should start with.
     * Landed balls reuse their actual rest velocity; never-flown balls fall
     * back to the ghost-path steady state for the current beat, and if that
     * beat's slot is empty ({0, 0} - the hand doesn't throw then, or the
     * player is off-beat) to a typical catch speed harvested from whichever
     * beat in the pattern gives the steepest scoop for this hand.
     *
     * Height-1 throws are a special case: they land with a much shallower
     * vertical speed than taller throws, so feeding that rest velocity
     * straight back into the next 1 makes the carry look flat even though
     * the hand should still recoil. When chaining 1s, keep the actual
     * horizontal catch momentum but borrow the pattern's usual downward
     * recoil on the vertical axis (see height check below).
     */
    resolveIncomingVelocity(ball, hand, height) {
        const typical = this.physics.getTypicalSteadyStateIncoming(hand);

        if (ball.restVelocity.x === 0 && ball.restVelocity.y === 0) {
            const atBeat = this.physics.getSteadyStateIncoming(hand, this.beatIndex);
            if (atBeat.x !== 0 || atBeat.y !== 0) return atBeat;
            return typical;
        }

        const rest = ball.restVelocity;
        if (height === 1 && typical.y < 0 && rest.y > typical.y) {
            return { x: rest.x, y: typical.y };
        }
        return rest;
    }

    /**
     * Lands any manually-thrown ball whose flight has finished by now, into
     * the outer end of its destination hand's queue.
     *
     * Also doubles as the game's only "missed throw" detector: since none
     * of these patterns are multiplexed, a hand should never be holding
     * more than one *already-circulated* ball at a time once real play is
     * underway - if a catch lands on top of one of those, that resting
     * ball's throw never happened, which breaks the sequence streak exactly
     * like a wrong throw would (see recordThrowSequenceOutcome).
     *
     * Deliberately checks each resting ball's own everThrown flag rather
     * than just the queue's length: buildInitialQueues can bulk-deal
     * several balls into the same hand's queue up front (e.g. a pattern
     * needing 3 balls in one hand), and those are still waiting on their
     * own first turn, not backlogged - so a real catch landing on top of
     * one of them (which can happen on the very same beat that ball is
     * about to be thrown, once its natural turn comes up) must not count
     * as a miss. Once a ball has actually been thrown at least once,
     * though, finding it still sitting there when another lands is a
     * genuine miss. Gated on throwSequenceStarted so fumbling before the
     * player's first-ever correct throw is already exempt from mismatches.
     */
    resolveLandings(uptoTime = this.time) {
        for (let i = this.inFlight.length - 1; i >= 0; i--) {
            const entry = this.inFlight[i];
            if (entry.flight.endTime <= uptoTime + LANDING_EPSILON) {
                const queue = this.queues[entry.destHand];
                if (this.throwSequenceStarted && queue.some((waiting) => waiting.everThrown)) {
                    this.recordThrowSequenceOutcome(null, null, null);
                }
                entry.ball.restVelocity = entry.flight.landVelocity;
                queue.push(entry.ball);
                this.inFlight.splice(i, 1);
            }
        }
    }

    tick(timestamp) {
        const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
        this.lastTimestamp = timestamp;

        // Sub-step so a single long frame (tab backgrounded, hitch) can't
        // leap past a throw's whole carry phase - especially noticeable on
        // low "1" throws, where carry is a large share of a short duration
        // and the ball never leaves the hand region. Beat boundaries are
        // processed inside the sub-step loop at exact simulation times so
        // catches always land before beat-locked throws on the same beat.
        const delta = dt * this.physics.timeScale;
        const maxStep = this.physics.carryDuration / 8;
        const beatDuration = this.physics.beatDuration;
        let remaining = delta;
        while (remaining > 0) {
            const step = Math.min(maxStep, remaining);
            const targetTime = this.time + step;

            while (this.nextBeatTime <= targetTime + LANDING_EPSILON) {
                this.resolveLandings(this.nextBeatTime + LANDING_EPSILON);
                this.beatIndex = (this.beatIndex + 1) % this.period;
                this.onBeat();
                this.nextBeatTime += beatDuration;
            }

            this.time = targetTime;
            this.resolveLandings();
            remaining -= step;
        }
        if (this.isCompetitive) {
            this.updateGrooveCountdown();
            // triggerGameOver() already called this.stop() (rafId is back
            // to null) - bail out here rather than drawing one more frame
            // and scheduling a tick that would never get cancelled.
            if (this.gameOverTriggered) return;
        }

        this.expireBeatFlashes();
        this.updateChargeTicks();

        this.draw();

        this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    }

    draw() {
        const beatDuration = this.physics.beatDuration;
        const beatStart = this.nextBeatTime - beatDuration;
        const beatProgress = Math.min(Math.max((this.time - beatStart) / beatDuration, 0), 1);
        this.$beatBar.css('transform', `scaleX(${1 - beatProgress})`);

        const balls = [];
        for (const hand of ['L', 'R']) {
            const queue = this.queues[hand];
            for (let i = 0; i < queue.length; i++) {
                const slot = queueSlotIndexForRender(
                    i, this.time, this.queueShiftStart[hand], this.queueShiftUntil[hand],
                );
                const pos = queueSlotPosition(this.physics.hands, this.physics.handY, this.ballRadius, hand, slot);
                balls.push({ id: queue[i].id, x: pos.x, y: pos.y, radius: this.ballRadius, color: queue[i].color });
            }
        }
        for (const entry of this.inFlight) {
            const pos = entry.flight.positionAt(this.time);
            balls.push({ id: entry.ball.id, x: pos.x, y: pos.y, radius: this.ballRadius, color: entry.ball.color });
        }

        const wedges = [];
        for (const hand of ['L', 'R']) {
            const anchor = this.renderer.worldToScreen(this.physics.hands[hand].outerX, this.physics.handY);
            wedges.push(this.buildWedgeState(hand, anchor));
        }

        // A synchronous step's two paths (see buildThrowSequenceSteps) both
        // stay highlighted together, dropping out individually as each
        // hand's throw actually lands - not tied to a single flat index.
        const currentStepBeat = this.throwSequenceSteps[this.throwSequenceIndex].beat;
        const staticPaths = this.paths.map((path) => ({
            points: path.points,
            highlighted: !this.throwSequenceHidden
                && path.beat === currentStepBeat
                && this.throwSequencePending.has(path.hand),
        }));

        this.renderer.draw({
            balls,
            staticPaths,
            ballRadius: this.ballRadius,
            wedges,
            jugglingBounds: this.computeJugglingScreenBounds(staticPaths),
            bokehIntensity: this.getBokehIntensity(),
        });
    }

    /**
     * 0-1 fade-in for Renderer's background bokeh wash (see
     * Renderer.drawBokeh's `intensity`), climbing with the player's own
     * consecutive correct throws rather than jumping in one step per full
     * clean period the way soundtrackSuccessCount's chord-progression
     * advances do - soundtrackSuccessCount/effectivePeriodForMusic is this
     * period's own fractional progress, handed to Soundtrack as the
     * "current period" term its own periodsCompleted-based progress is
     * missing (see getVisualProgress), so the two stay in exact lockstep -
     * a mismatch resetting soundtrackSuccessCount to 0 also visibly drops
     * this back down, and it lands fully on at the exact same throw the
     * echo voice itself starts on.
     */
    getBokehIntensity() {
        const periodBeats = this.physics.effectivePeriodForMusic;
        const fraction = periodBeats > 0 ? this.soundtrackSuccessCount / periodBeats : 0;
        return this.soundtrack.getVisualProgress(fraction);
    }

    /**
     * Horizontal screen edges of the pattern's fixed geometry - hand
     * positions and ghost paths, both constant for this Game's whole life -
     * for wedge placement. Deliberately excludes anything that actually
     * moves: not just queued balls (which can stack arbitrarily wide, sit
     * below the wedges anyway, and have nothing to do with the pattern's
     * shape), but also live in-flight balls - a throw's carry phase briefly
     * recoils past the hand's catch point (see Throw.carryPositionAt),
     * which, if included, would nudge these bounds - and therefore the
     * wedges - by a few pixels right at the moment a queue changes, visible
     * as an unwanted slide (most noticeable on narrow screens, where the
     * wedge sits at its uncapped "ideal" position instead of pinned against
     * WEDGE_MAX_OFFSET_FROM_CENTER). The ghost paths already trace that same
     * carry-overshoot shape, just as fixed data, so nothing is lost by
     * sizing around them instead of the live balls. Also kept separate from
     * this.extent, which is padded for worst-case queue growth and camera
     * fit only (see buildExtent).
     */
    computeJugglingScreenBounds(staticPaths) {
        const p = this.physics;
        let minX = p.hands.L.outerX;
        let maxX = p.hands.R.outerX;

        for (const entry of staticPaths) {
            for (const point of entry.points) {
                minX = Math.min(minX, point.x);
                maxX = Math.max(maxX, point.x);
            }
        }

        const y = p.handY;
        return {
            left: this.renderer.worldToScreen(minX, y).x,
            right: this.renderer.worldToScreen(maxX, y).x,
        };
    }

    /**
     * Wedge HUD state for one hand - always returned (see class doc) so both
     * wedges stay visible even with nothing going on: beat flash, yellow
     * lock, white charge, or (falling through every one of those) a fully
     * unlit idle wedge. `target` is attached regardless of state, since the
     * target indicator is meant to be watched independent of whether a
     * throw is currently being charged.
     */
    buildWedgeState(hand, anchor) {
        const base = {
            hand,
            anchor,
            crossHeights: this.crossHeights,
            selfHeights: this.selfHeights,
            sync: this.isSync,
            target: this.computeTargetState(hand),
        };

        const flash = this.beatFlash[hand];
        if (flash) {
            return {
                ...base,
                activeSide: flash.crossing ? 'cross' : 'self',
                litRings: flash.litRings,
                beatFlash: flash.color,
            };
        }

        const danger = this.dangerHold[hand];
        if (danger) {
            const heights = danger.crossing ? this.crossHeights : this.selfHeights;
            return {
                ...base,
                activeSide: danger.crossing ? 'cross' : 'self',
                litRings: heights.length,
                beatFlash: 'red',
            };
        }

        const locked = this.lockedThrow[hand];
        if (locked) {
            return {
                ...base,
                activeSide: locked.crossing ? 'cross' : 'self',
                litRings: locked.litRings,
                locked: true,
            };
        }

        const charge = this.charging[hand];
        if (charge) {
            const state = this.getChargeState(hand);
            // Past the cancel-flash window, a still-held key shows nothing
            // until release + a fresh press (see resolveBeatThrow) - same
            // idle appearance as the no-charge case below.
            if (!state.wedgeHidden) {
                return {
                    ...base,
                    activeSide: charge.crossing ? 'cross' : 'self',
                    litRings: state.litRings,
                    cancelFlash: state.cancelFlash,
                };
            }
        }

        return { ...base, activeSide: null, litRings: 0 };
    }

    /** Re-fit and redraw against the same fixed geometry (e.g. on resize). */
    handleResize() {
        this.renderer.fit(this.extent);
        this.draw();
    }

    /**
     * `hideHud: false` (see triggerGameOver's doc comment) skips instantly
     * `.hidden`-ing the beat bar/groove countdown - used only for the very
     * first stop() call after a competitive loss, while they're still
     * fully visible on screen; every other caller (the Stop button, a
     * fresh startGame/startDemo tearing down a previous session, and
     * clearSession's own later call once a game-over's fade is actually
     * done) wants the normal immediate hide.
     */
    stop({ hideHud = true } = {}) {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        for (const scheme of this.inputSchemes) scheme.detach();
        this.charging = { L: null, R: null };
        this.lockedThrow = { L: null, R: null };
        this.beatFlash = { L: null, R: null };
        this.dangerHold = { L: null, R: null };
        if (this.isCompetitive) this.grooveCountdownActive = false;
        if (hideHud) {
            this.$beatBarWrap.addClass('hidden');
            if (this.isCompetitive && this.$grooveCountdown) this.$grooveCountdown.addClass('hidden');
        }
    }
}
