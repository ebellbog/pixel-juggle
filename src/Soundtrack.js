const MUTED_STORAGE_KEY = 'pixel-juggle-muted';

// Major pentatonic (no two degrees a semitone or tritone apart), so any
// sequence of throw heights - in whatever order the player or a pattern
// happens to produce them - lands on notes that sound musical together
// rather than clashing. The default shape a progression step climbs
// through (see PROGRESSION/frequencyForThrow) unless that step picks its
// own, like MAJOR_TRIAD_INTERVALS below.
const MAJOR_PENTATONIC_INTERVALS = [0, 2, 4, 7, 9];
// Final resolution intervals
const RESOLUTION_INTERVALS = [0, 2, 4, 6, 7];
const BASE_MIDI_NOTE = 57; // A3 - low enough to leave room for taller throws to climb, high enough not to feel muddy.

/**
 * I-V-IV-IV(as a plain triad), each step a `{ root, intervals }` pair
 * rather than just a root offset - advancePeriod() below steps through this
 * once per full period
 * of the pattern, and frequencyForThrow reads whichever step is current
 * for *both* the root a height's run starts from and the interval shape
 * it climbs through. A shared, single interval set could only ever be
 * transposed around by a step's root (which is all this used to do); a
 * real change in a chord's *quality* - like the last step resolving to a
 * plain triad instead of another pentatonic run - needs its own
 * intervals, not just another root. That last step deliberately reuses
 * IV's own root rather than introducing a new one, landing as a clear
 * "home" cadence to close out the loop before it repeats from I again.
 */
const PROGRESSION = [
    { root: 0, intervals: MAJOR_PENTATONIC_INTERVALS }, // I
    { root: 7, intervals: MAJOR_PENTATONIC_INTERVALS }, // V
    { root: 5, intervals: MAJOR_PENTATONIC_INTERVALS }, // IV
    { root: 5, intervals: RESOLUTION_INTERVALS }, // IV, vesolved as a plain major triad
];

// Lap 1 of the chord progression (a "lap" being PROGRESSION.length periods)
// plays plain; lap 2 brings in the drum break (see playBeat); lap 3 brings
// in the octave-echo throw voice on top of that (see playThrow) - and both
// stay on for every lap after, since nothing here ever turns a stage back
// off once its lap is reached, only a mismatch resets everything back to
// lap 1 (see resetProgression). 1-indexed lap numbers rather than a raw
// period count, so retuning PROGRESSION's own length doesn't silently
// shift when either stage kicks in.
const DRUM_BREAK_STARTS_ON_LAP = 2;
const ECHO_VOICE_STARTS_ON_LAP = 3;
// periodsCompleted value at which DRUM_BREAK_STARTS_ON_LAP begins - pulled
// out to its own name for the same reason as ECHO_VOICE_PERIODS_THRESHOLD
// below: getVisualProgress uses it as the zero point its own 0-1 fade
// climbs from (rather than plain periodsCompleted 0), so a purely visual
// effect gated on that progress (Renderer's bokeh wash/fluid sim) starts
// fading in at exactly the same instant the drum break itself kicks in,
// rather than already being partway faded in by then.
const DRUM_BREAK_PERIODS_THRESHOLD = (DRUM_BREAK_STARTS_ON_LAP - 1) * PROGRESSION.length;
// periodsCompleted value at which ECHO_VOICE_STARTS_ON_LAP begins - pulled
// out to its own name since both playThrow (to actually start the echo
// voice) and getVisualProgress (so a caller can fade a purely visual effect
// in over that exact same run, landing "fully on" at the same instant the
// echo does - see there) need to compare against it.
const ECHO_VOICE_PERIODS_THRESHOLD = (ECHO_VOICE_STARTS_ON_LAP - 1) * PROGRESSION.length;
// A full octave above the main note - a plain octave fuses almost
// completely into a single, richer-sounding note when both voices start at
// the same instant (same pitch "chroma", just twelve semitones apart), but
// offsetting the echo's own start time (see ECHO_OFFSET_BEAT_FRACTION)
// keeps the two rhythmically distinct, so the octave reads as a second,
// separate voice rather than just thickening the first (see playThrow).
const ECHO_INTERVAL_SEMITONES_ABOVE = 12;
// How far into each beat of flight the echo voice starts, as a fraction of
// one beat - 0.5 lands it right on the off-beat, halfway between this
// throw's own beat and the next one, rather than doubling up with it.
const ECHO_OFFSET_BEAT_FRACTION = 0.5;
// Quieter than the main note (see playThrow/playTone's volumeScale) - at
// full volume the octave-up pitch reads as piercing next to the mellower
// main tone.
const ECHO_VOLUME_SCALE = 0.45;

const THROW_ATTACK_SECONDS = 0.014;
const THROW_PEAK_GAIN = 0.16;
// The decay is almost entirely one continuous exponential ramp, all the way
// from the peak down to THROW_FLOOR_RATIO (a fraction of peak, chosen to
// already be well below audible - see below) at THROW_DECAY_FRACTION of the
// way through the flight - a constant rate of dB loss per second, which is
// what actually reads as an even, continuous fade throughout the *whole*
// flight rather than holding steady and then suddenly dropping off. Only
// the last sliver is handed off to a plain linear ramp down to true zero -
// exponentialRampToValueAtTime can't target 0 exactly, but since the floor
// it hands off from is already inaudible, that final ramp's own (very
// differently-shaped) curve never actually gets heard.
const THROW_DECAY_FRACTION = 0.94;
const THROW_FLOOR_RATIO = 0.012; // ~ -38dB below peak
const MIN_AUDIBLE_GAIN = 0.0001; // exponentialRampToValueAtTime can't target 0 exactly.

// Two sine layers a few cents apart (rather than one single richer
// waveform) beat softly against each other for an airy, choral shimmer;
// a slow shared vibrato adds a gentle, natural waver on top. Both layers
// stay pure sines - no harmonic overtones at all - for the mellowest,
// least "buzzy" color the Web Audio API's built-in waveforms can make.
const THROW_DETUNE_CENTS = 9;
const THROW_VIBRATO_RATE_HZ = 4.5;
const THROW_VIBRATO_DEPTH_RATIO = 0.006; // vibrato depth as a fraction of the note's own frequency

// A wider, deeper pitch sweep (higher start, lower end) plus a longer decay
// than a plain click reads as a bigger, more booming low-end thump.
const KICK_START_HZ = 190;
const KICK_END_HZ = 24;
const KICK_PITCH_DROP_SECONDS = 0.1;
const KICK_DECAY_SECONDS = 0.42;
const KICK_PEAK_GAIN = 1;

// A second, fixed-pitch sine underneath the sweep above, decaying more
// slowly than it - the sweep alone is really more of a "thump" (its pitch
// has already fallen out of boom range by the time it's mid-decay); this
// sustains the low end a beat longer underneath it, which is what actually
// reads as a deep boom rather than just a louder click.
const KICK_SUB_HZ = 36;
const KICK_SUB_GAIN_RATIO = 0.85; // relative to KICK_PEAK_GAIN
const KICK_SUB_DECAY_SECONDS = 0.52;
// Every beat subdivides into this many quarter-beat kicks, each quieter than
// the last (KICK_ECHO_DECAY per step) so it reads as one hit echoing and
// trailing off rather than four equally-loud hits - see playEchoKick. A low
// ratio here is what makes that trail-off read as *fast* - only the main
// downbeat really booms, and the following three are a quick, receding tail.
const KICK_SUBDIVISIONS = 4;
const KICK_ECHO_DECAY = 0.3;

// A short burst of filtered noise (the "snap") plus a quick low-triangle
// thump underneath (the "body") - same two-layer idea as the kick, just
// higher and much shorter so the two stay clearly distinct hits rather than
// one blurring into the other - see playSnare.
const SNARE_NOISE_DECAY_SECONDS = 0.14;
const SNARE_NOISE_PEAK_GAIN = 0.55;
const SNARE_NOISE_HIGHPASS_HZ = 1400; // strips the low end noise would otherwise share with the kick, leaving just the crack.
const SNARE_TONE_HZ = 190;
const SNARE_TONE_DECAY_SECONDS = 0.05;
const SNARE_TONE_PEAK_GAIN = 0.32;

// A quiet, quick click per additional ring lit while charging a throw (see
// playChargeTick/Game.updateChargeTicks) - short enough, and quiet enough,
// to read as a subtle feedback tick rather than competing with the beat's
// own percussion or an actual throw's tone.
const CHARGE_TICK_BASE_HZ = 640;
// Each ring a semitone-ish step above the last, so a full charge reads as a
// short rising run rather than identical clicks - deliberately not tied to
// PROGRESSION/frequencyForThrow at all, since this is charge progress, not
// a pitch that needs to match anything a throw will actually sound like.
const CHARGE_TICK_SEMITONES_PER_RING = 2.5;
const CHARGE_TICK_DECAY_SECONDS = 0.045;
const CHARGE_TICK_PEAK_GAIN = 0.09;
// A separate overall volume knob on top of CHARGE_TICK_PEAK_GAIN, rather
// than just tuning that constant directly, so it's easy to keep coming back
// and nudging this one number later without having to re-derive the peak.
const CHARGE_TICK_VOLUME_SCALE = 0.85;

/**
 * A four-bar drum break (see playBeat) that phases in on
 * DRUM_BREAK_STARTS_ON_LAP, each hit expressed as a fraction of one beat so
 * they scale with tempo exactly
 * like KICK_SUBDIVISIONS' echo does. Bar 3 repeats bar 1 before bar 4's
 * three-kick run, rather than going straight from bar 2 into bar 4, so the
 * "kick, dotted-quarter kick, snare" bar reads as an occasional variation
 * on the basic bar instead of every other one.
 */
const DRUM_BREAK_MEASURES = [
    [{ sound: 'kick', at: 0 }, { sound: 'snare', at: 1 / 2 }],
    [{ sound: 'kick', at: 0 }, { sound: 'kick', at: 3 / 8 }, { sound: 'snare', at: 1 / 2 }],
    [{ sound: 'kick', at: 0 }, { sound: 'snare', at: 1 / 2 }, {sound: 'kick', at: 3 / 4 }],
    [{ sound: 'kick', at: 0 }, { sound: 'kick', at: 1 / 4 }, {sound: 'snare', at: 1 / 2 }],
];

/**
 * Every sound this game makes: an echoing kick on each beat that gives way,
 * on DRUM_BREAK_STARTS_ON_LAP, to a four-bar kick/snare drum break (see
 * playBeat/periodsCompleted) - a tone per throw (gaining an
 * off-beat octave echo on ECHO_VOICE_STARTS_ON_LAP - see playThrow) whose
 * pitch depends on its height (see frequencyForThrow), transposed to a new
 * chord as the pattern repeats (see advancePeriod) - and a quiet rising
 * click per ring lit while a throw is being charged (see
 * playChargeTick/Game.updateChargeTicks). Deliberately the
 * *only* file that touches the Web Audio API, so the whole feature stays
 * easy to mute (setMuted/toggleMuted) or delete outright later - removing
 * this file and its handful of call sites (Game.onBeat/executeThrow, App's
 * JugglingSimulator onBeat/onThrow options) leaves every actual
 * gameplay/physics class untouched.
 *
 * Every public method is a safe no-op if Web Audio isn't available at all,
 * so callers never need to feature-detect or null-check this class
 * themselves - they can just always have one and call into it.
 *
 * Synthesized directly rather than played back as real MIDI: real MIDI
 * needs a soundfont/synth somewhere downstream to actually receive those
 * note events, which buys nothing here over generating the waveform
 * ourselves - and direct synthesis gets sample-accurate scheduling for
 * free, which matters since a throw's fade has to land exactly on its own
 * catch time (see playThrow).
 */
export default class Soundtrack {
    constructor() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.context = AudioContextClass ? new AudioContextClass() : null;

        let mutedByDefault = false;
        try {
            mutedByDefault = window.localStorage?.getItem(MUTED_STORAGE_KEY) === '1';
        } catch {
            // Storage access can throw in some private-browsing modes - just start unmuted.
        }
        this.muted = mutedByDefault;
        // Index into PROGRESSION - which chord the pattern's *current*
        // period is playing in (see advancePeriod/frequencyForThrow).
        this.progressionIndex = 0;
        // Total times advancePeriod has been called since the last reset -
        // i.e. how many periods of a clean run have gone by. Every "reward
        // for staying clean longer" stage (the octave echo, the drum break -
        // see playThrow/playBeat) just compares this against its own
        // threshold rather than tracking its own separate boolean, so
        // there's one clock behind all of them and adding another stage
        // later is just another comparison against it.
        this.periodsCompleted = 0;
        // Which of DRUM_BREAK_MEASURES plays next, once the break's active -
        // advances every beat (see playBeat) and wraps back to its first
        // bar once all of them have played, rather than any one bar just
        // repeating on its own.
        this.drumBreakMeasureIndex = 0;
        // Lazily built on first use (see buildNoiseBuffer) - every snare hit
        // reuses the same buffer rather than regenerating random noise data
        // each time, since none of that data's specifics actually matter.
        this.noiseBuffer = null;

        if (this.context) {
            this.masterGain = this.buildMasterGain();
        }
    }

    /** A fresh gain -> compressor -> destination chain, honoring the current mute state. */
    buildMasterGain() {
        const gain = this.context.createGain();
        gain.gain.value = this.muted ? 0 : 1;
        // A light limiter, not tonal shaping - several throws and a beat
        // click can land at once (a five-ball pattern, say), and this keeps
        // that from ever actually clipping instead of asking every voice's
        // individual gain to guess at worst-case overlap.
        const compressor = this.context.createDynamicsCompressor();
        gain.connect(compressor);
        compressor.connect(this.context.destination);
        return gain;
    }

    /**
     * Must be called from within a user-gesture handler (a click) - browsers
     * refuse to actually produce sound from an AudioContext until one
     * happens, so this alone doesn't guarantee audio, but nothing will play
     * at all without it.
     *
     * Returns a promise that resolves once the context has actually left
     * 'suspended' (or resolves immediately if there was never anything to
     * resume) - context.resume() itself is async, and callers whose very
     * first sound follows right on its heels (see App.startDemo/startGame,
     * where the demo's first beat/throw fires on literally the next
     * animation frame) need to await that before scheduling anything: a
     * playTone/playKick's `now` is read from context.currentTime, which is
     * frozen while still 'suspended', so scheduling against it before
     * resume() has actually settled is what reads as the very first note
     * getting silently dropped or clipped once the context does wake up.
     */
    resume() {
        if (!this.context) return Promise.resolve();
        if (this.context.state === 'suspended') {
            return this.context.resume().catch(() => {});
        }
        return Promise.resolve();
    }

    isMuted() {
        return this.muted;
    }

    setMuted(muted) {
        this.muted = muted;
        if (this.masterGain) {
            this.masterGain.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.02);
        }
        try {
            window.localStorage?.setItem(MUTED_STORAGE_KEY, muted ? '1' : '0');
        } catch {
            // Private browsing etc - losing the preference on reload isn't worth failing over.
        }
    }

    toggleMuted() {
        this.setMuted(!this.muted);
        return this.muted;
    }

    /**
     * 0 (still on DRUM_BREAK_STARTS_ON_LAP's own plain lap) to 1
     * (ECHO_VOICE_STARTS_ON_LAP reached), climbing linearly in between -
     * exposed so a purely visual "reward for staying clean" effect (see
     * Renderer's bokeh wash/fluid sim, Game/App's bokehIntensity) can fade
     * in over exactly the same clean run the echo voice itself builds up
     * over, *starting* at the same instant the drum break does and landing
     * fully visible at the same instant the echo voice does - rather than
     * (as a flat periodsCompleted/ECHO_VOICE_PERIODS_THRESHOLD would)
     * already being partway faded in by the time anything is actually
     * gated on this to become visible.
     *
     * `fractionalPeriodProgress` (0-1, how far into the *current*, not-yet-
     * counted period the caller's own beat/throw clock already is - see
     * Game.getBokehIntensity/App.buildDemoRenderState, both of which
     * already compute and pass this) is what keeps this climbing
     * continuously beat-to-beat rather than only ticking in whole steps
     * once per full period whenever periodsCompleted itself changes -
     * without it, progress sits at exactly 0 for the entirety of the lap
     * where the drum break actually starts (periodsCompleted hasn't
     * incremented again yet), which reads as a delay before the effect
     * appears at all, not a fade beginning right on cue.
     */
    getVisualProgress(fractionalPeriodProgress = 0) {
        const span = ECHO_VOICE_PERIODS_THRESHOLD - DRUM_BREAK_PERIODS_THRESHOLD;
        if (span <= 0) return 1;
        const progress = this.periodsCompleted + fractionalPeriodProgress - DRUM_BREAK_PERIODS_THRESHOLD;
        return Math.max(0, Math.min(1, progress / span));
    }

    /**
     * Fires once per beat, regardless of whether anything is actually
     * thrown on it - the pulse keeps going even through a siteswap "0"
     * rest. Plain echoing kick (see playEchoKick) until a full lap of the
     * chord progression has gone by (see periodsCompleted/PROGRESSION),
     * then switches over to the DRUM_BREAK_MEASURES break for as long as
     * that stays true, advancing one bar per beat and looping back to the
     * start once they've all played. `beatDurationSeconds` is the
     * real-world length of one beat at whatever tempo is currently live
     * (see Game.onBeat/JugglingSimulator's onBeat option), so every
     * subdivision below lands at exactly the right fraction of it
     * regardless of BPM.
     */
    playBeat(beatDurationSeconds) {
        if (!this.context) return;
        const now = this.context.currentTime;

        if (this.periodsCompleted < DRUM_BREAK_PERIODS_THRESHOLD) {
            this.playEchoKick(now, beatDurationSeconds);
            return;
        }

        const measure = DRUM_BREAK_MEASURES[this.drumBreakMeasureIndex];
        for (const hit of measure) {
            const startTime = now + hit.at * beatDurationSeconds;
            if (hit.sound === 'kick') this.playKick(startTime, 1);
            else this.playSnare(startTime, 1);
        }
        this.drumBreakMeasureIndex = (this.drumBreakMeasureIndex + 1) % DRUM_BREAK_MEASURES.length;
    }

    /**
     * The pre-break beat: KICK_SUBDIVISIONS quarter-beat hits, each quieter
     * than the last, so it reads as one kick echoing and trailing off
     * through the rest of the beat rather than a single flat hit or (once
     * DRUM_BREAK_MEASURES kicks in) a repeated stomp.
     */
    playEchoKick(now, beatDurationSeconds) {
        const subdivisionSeconds = beatDurationSeconds / KICK_SUBDIVISIONS;
        for (let i = 0; i < KICK_SUBDIVISIONS; i++) {
            this.playKick(now + i * subdivisionSeconds, KICK_ECHO_DECAY ** i);
        }
    }

    /**
     * One kick hit: a pure sine plunging from KICK_START_HZ to KICK_END_HZ
     * under a matching gain decay for the "thump" transient, plus a second,
     * fixed-pitch sine (see KICK_SUB_HZ) that lingers a little longer for
     * the sustained low-end "boom" underneath it - no separate attack
     * transient on either, just those two decays overlapping.
     */
    playKick(startTime, gainScale) {
        const osc = this.context.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(KICK_START_HZ, startTime);
        osc.frequency.exponentialRampToValueAtTime(KICK_END_HZ, startTime + KICK_PITCH_DROP_SECONDS);

        const gain = this.context.createGain();
        gain.gain.setValueAtTime(KICK_PEAK_GAIN * gainScale, startTime);
        gain.gain.exponentialRampToValueAtTime(MIN_AUDIBLE_GAIN, startTime + KICK_DECAY_SECONDS);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(startTime);
        osc.stop(startTime + KICK_DECAY_SECONDS + 0.02);

        const sub = this.context.createOscillator();
        sub.type = 'sine';
        sub.frequency.value = KICK_SUB_HZ;

        const subGain = this.context.createGain();
        subGain.gain.setValueAtTime(KICK_PEAK_GAIN * KICK_SUB_GAIN_RATIO * gainScale, startTime);
        subGain.gain.exponentialRampToValueAtTime(MIN_AUDIBLE_GAIN, startTime + KICK_SUB_DECAY_SECONDS);

        sub.connect(subGain);
        subGain.connect(this.masterGain);
        sub.start(startTime);
        sub.stop(startTime + KICK_SUB_DECAY_SECONDS + 0.02);
    }

    /** A one-second buffer of white noise, generated once and reused by every snare hit (see playSnare) - its exact contents never matter, just its statistics. */
    buildNoiseBuffer() {
        if (this.noiseBuffer) return this.noiseBuffer;
        const buffer = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        this.noiseBuffer = buffer;
        return buffer;
    }

    /**
     * One snare hit: a short burst of high-passed noise for the "crack"
     * (see SNARE_NOISE_HIGHPASS_HZ - filtered so it doesn't just blur
     * together with the kick's own low end), plus a much quicker low
     * triangle thump underneath for a bit of body, same layering idea as
     * playKick just higher and shorter.
     */
    playSnare(startTime, gainScale) {
        const noise = this.context.createBufferSource();
        noise.buffer = this.buildNoiseBuffer();

        const highpass = this.context.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = SNARE_NOISE_HIGHPASS_HZ;

        const noiseGain = this.context.createGain();
        noiseGain.gain.setValueAtTime(SNARE_NOISE_PEAK_GAIN * gainScale, startTime);
        noiseGain.gain.exponentialRampToValueAtTime(MIN_AUDIBLE_GAIN, startTime + SNARE_NOISE_DECAY_SECONDS);

        noise.connect(highpass);
        highpass.connect(noiseGain);
        noiseGain.connect(this.masterGain);
        noise.start(startTime);
        noise.stop(startTime + SNARE_NOISE_DECAY_SECONDS + 0.02);

        const tone = this.context.createOscillator();
        tone.type = 'triangle';
        tone.frequency.value = SNARE_TONE_HZ;

        const toneGain = this.context.createGain();
        toneGain.gain.setValueAtTime(SNARE_TONE_PEAK_GAIN * gainScale, startTime);
        toneGain.gain.exponentialRampToValueAtTime(MIN_AUDIBLE_GAIN, startTime + SNARE_TONE_DECAY_SECONDS);

        tone.connect(toneGain);
        toneGain.connect(this.masterGain);
        tone.start(startTime);
        tone.stop(startTime + SNARE_TONE_DECAY_SECONDS + 0.02);
    }

    /**
     * One quiet click for the `ringIndex`-th ring lit while charging a
     * throw (see Game.updateChargeTicks) - a single plain sine, no second
     * layer or sweep like the kick/snare above, since this needs to read as
     * a light tick under everything else rather than its own percussive
     * hit. Pitch climbs CHARGE_TICK_SEMITONES_PER_RING per ring so a full
     * charge reads as a short rising run, giving a clear, continuous sense
     * of climbing height without having to look at the wedge at all.
     */
    playChargeTick(ringIndex) {
        if (!this.context) return;
        const now = this.context.currentTime;
        const frequency = CHARGE_TICK_BASE_HZ * 2 ** ((ringIndex - 1) * CHARGE_TICK_SEMITONES_PER_RING / 12);

        const osc = this.context.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = frequency;

        const gain = this.context.createGain();
        gain.gain.setValueAtTime(CHARGE_TICK_PEAK_GAIN * CHARGE_TICK_VOLUME_SCALE, now);
        gain.gain.exponentialRampToValueAtTime(MIN_AUDIBLE_GAIN, now + CHARGE_TICK_DECAY_SECONDS);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + CHARGE_TICK_DECAY_SECONDS + 0.02);
    }

    /**
     * One tone per throw (see playTone for the voice itself) - or, from
     * ECHO_VOICE_STARTS_ON_LAP on (see periodsCompleted), a second echo
     * voice too: the same note ECHO_INTERVAL_SEMITONES_ABOVE higher (a
     * fixed ratio applied to whatever `frequency` already came out of
     * frequencyForThrow - not a second, independent lookup into
     * PROGRESSION's own intervals, so the gap between the two voices never
     * varies with whichever chord happens to be active), starting
     * ECHO_OFFSET_BEAT_FRACTION of a beat later than the main note rather
     * than alongside it, so it reads as a rhythmic echo rather than a
     * simultaneous chord, and quieter (see ECHO_VOLUME_SCALE) so the
     * octave-up pitch doesn't pierce over the main tone.
     * `durationSeconds` is the real-time span from this throw to its own
     * catch (height beats at the current tempo - see
     * Game.executeThrow/JugglingSimulator.executeThrow); the echo's own,
     * shorter duration is trimmed by exactly its own start offset so it
     * still fades out at that same catch time, not later.
     */
    playThrow({ hand, height, durationSeconds }) {
        if (!this.context || !(durationSeconds > 0)) return;
        const frequency = this.frequencyForThrow(hand, height);
        this.playTone(frequency, durationSeconds);
        if (this.periodsCompleted >= ECHO_VOICE_PERIODS_THRESHOLD) {
            const beatDurationSeconds = durationSeconds / height;
            const echoOffsetSeconds = beatDurationSeconds * ECHO_OFFSET_BEAT_FRACTION;
            this.playTone(
                frequency * 2 ** (ECHO_INTERVAL_SEMITONES_ABOVE / 12),
                durationSeconds - echoOffsetSeconds,
                echoOffsetSeconds,
                ECHO_VOLUME_SCALE,
            );
        }
    }

    /**
     * One sustained voice at `frequency`: two detuned sine layers under a
     * shared vibrato (see THROW_DETUNE_CENTS/THROW_VIBRATO_*), volume
     * rising through a short attack then fading back to silence by
     * `durationSeconds`, taller throws simply getting a longer, slower fade
     * than short ones (see THROW_DECAY_FRACTION for why that fade is almost
     * entirely one continuous ramp rather than two very differently-shaped
     * stages). Pulled out of playThrow so an echoed throw can layer a
     * second, independent voice at another frequency, start time (see
     * `startOffsetSeconds`), and volume (see `volumeScale`) on top of this
     * one.
     */
    playTone(frequency, durationSeconds, startOffsetSeconds = 0, volumeScale = 1) {
        const now = this.context.currentTime + startOffsetSeconds;
        const peakGain = THROW_PEAK_GAIN * volumeScale;

        const attackEndTime = now + THROW_ATTACK_SECONDS;
        const decayEndTime = Math.max(attackEndTime + 0.02, now + durationSeconds * THROW_DECAY_FRACTION);
        const fadeEndTime = now + durationSeconds;

        const voiceGain = this.context.createGain();
        voiceGain.gain.setValueAtTime(MIN_AUDIBLE_GAIN, now);
        voiceGain.gain.exponentialRampToValueAtTime(peakGain, attackEndTime);
        voiceGain.gain.exponentialRampToValueAtTime(peakGain * THROW_FLOOR_RATIO, decayEndTime);
        voiceGain.gain.linearRampToValueAtTime(0, fadeEndTime);

        const filter = this.context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 0.6;
        filter.frequency.value = Math.min(frequency * 3, 2400);
        filter.connect(voiceGain);
        voiceGain.connect(this.masterGain);

        // A shared slow vibrato feeds both sine layers below, so they waver
        // together rather than drifting in and out of tune with each other.
        const vibrato = this.context.createOscillator();
        vibrato.type = 'sine';
        vibrato.frequency.value = THROW_VIBRATO_RATE_HZ;
        const vibratoDepth = this.context.createGain();
        vibratoDepth.gain.value = frequency * THROW_VIBRATO_DEPTH_RATIO;
        vibrato.connect(vibratoDepth);
        vibrato.start(now);
        vibrato.stop(fadeEndTime + 0.05);

        const detuneRatio = 2 ** (THROW_DETUNE_CENTS / 1200);
        for (const layerFrequency of [frequency, frequency * detuneRatio]) {
            const osc = this.context.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = layerFrequency;
            vibratoDepth.connect(osc.frequency);
            osc.connect(filter);
            osc.start(now);
            osc.stop(fadeEndTime + 0.05);
        }
    }

    /**
     * Steps to the next chord in PROGRESSION - call once every time a full
     * cycle of the pattern completes: on a plain beat count for the
     * scripted demo (see JugglingSimulator.processBeat's onBeat option), or
     * on the player's own run of correct throws in "let me try" (see
     * Game.recordThrowSequenceOutcome/soundtrackSuccessCount) - so every
     * throw from here until the next step uses the new chord's root and
     * interval shape.
     *
     * Also advances periodsCompleted, the shared clock every "reward for
     * staying clean longer" stage (the octave echo, the drum break - see
     * playThrow/playBeat) compares itself against. The moment it first
     * reaches DRUM_BREAK_STARTS_ON_LAP is also the cue to reset
     * drumBreakMeasureIndex back to the break's first bar - a one-time
     * thing, not something to redo every lap after that, since the break
     * should just keep going once it starts rather than restarting in sync
     * with the chords.
     */
    advancePeriod() {
        this.progressionIndex = (this.progressionIndex + 1) % PROGRESSION.length;
        this.periodsCompleted += 1;
        if (this.periodsCompleted === DRUM_BREAK_PERIODS_THRESHOLD) {
            this.drumBreakMeasureIndex = 0;
        }
    }

    /**
     * Snaps back to the first chord, drops the drum break back to the
     * plain echoing kick, and drops every throw's octave echo back to a
     * single tone - e.g. "let me try" resetting the progression after a
     * mismatch (see Game.recordThrowSequenceOutcome). Doesn't touch
     * anything currently playing.
     */
    resetProgression() {
        this.progressionIndex = 0;
        this.periodsCompleted = 0;
        this.drumBreakMeasureIndex = 0;
    }

    /**
     * Height -> scale degree, climbing the current chord's own interval
     * shape (see PROGRESSION/advancePeriod) as throws get taller, rooted at
     * that chord's own offset. Both hands share the exact same mapping for
     * now - an earlier right-hand octave bump made the two hands tellable
     * apart by ear, but made height itself harder to track since the same
     * height sounded different-ish depending which hand threw it; `hand`
     * is kept as a parameter so that's easy to reintroduce (or replace with
     * some other per-hand distinction) later without touching any call site.
     */
    frequencyForThrow(hand, height) {
        const { root, intervals } = PROGRESSION[this.progressionIndex];
        const index = Math.max(0, height - 1);
        const degree = index % intervals.length;
        const octave = Math.floor(index / intervals.length);
        const note = BASE_MIDI_NOTE + root + intervals[degree] + 12 * octave;
        return 440 * 2 ** ((note - 69) / 12);
    }

    /**
     * Immediately silences anything currently playing - used when a demo/
     * game is stopped or restarted outright, so a long throw's tail can't
     * linger into the menu screen or the next attempt.
     *
     * Swaps in a fresh master gain node rather than tracking and stopping
     * every individual oscillator/source: every currently-playing voice is
     * already connected only to the *old* node, so disconnecting that node
     * from the compressor silences all of them at once, harmlessly leaving
     * them to finish and get garbage-collected on their own.
     *
     * Also resets the chord progression back to its first chord, matching
     * the pattern itself restarting from its own beat/period zero.
     */
    stopAll() {
        this.resetProgression();
        if (!this.masterGain) return;
        this.masterGain.disconnect();
        this.masterGain = this.buildMasterGain();
    }
}
