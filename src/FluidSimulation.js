// A real GPU fluid simulation (Jos Stam's "Stable Fluids": advection +
// incompressible pressure projection + vorticity confinement) standing in
// for the background color effect - balls splat colored dye and a
// velocity impulse into the fluid as they fly, and the fluid's own
// advection/pressure-projection math does the rest (trailing, swirling,
// slowly calming down), rather than anything hand-animated. See
// Renderer.draw, which uses this if `FluidSimulation.tryCreate()` succeeds
// and falls back to the older drawBokeh effect otherwise (see there for
// why: this needs WebGL2 plus floating-point render targets, which not
// every device supports).
//
// Fully self-contained on purpose (mirrors how Soundtrack.js encapsulates
// all Web Audio state) - owns its own detached <canvas> and WebGL2
// context (a canvas can only ever expose one context type, and the main
// canvas is already '2d'), and knows nothing about balls/wedges/trails/
// ghost-paths as game concepts. Renderer just feeds it a plain array of
// `{ id, x, y, color }` in screen pixels each frame and copies the result
// in with ctx.drawImage - see `canvas` and `render`.

// Grid resolution for the expensive, iteratively-solved part of the sim
// (velocity/pressure/divergence/curl) - the "physics." This is the larger
// of the two grid dimensions; the other is derived from the canvas's own
// aspect ratio (see computeResolution) so the simulated area always
// matches the screen's actual shape.
const SIM_RESOLUTION = 128;
// Resolution for the visible color field - decoupled from SIM_RESOLUTION
// (same trick the reference demo linked in chat uses) so trails stay
// reasonably crisp on screen without paying full resolution on the
// iterative pressure solve.
const DYE_RESOLUTION = 512;
// Jacobi iterations per frame solving the pressure Poisson equation - more
// gives a more accurate (less "blobby"/compressible-looking) projection at
// proportionally more GPU cost.
const PRESSURE_ITERATIONS = 20;
// Multiplicative "fraction lost per second" applied during advection (see
// ADVECTION_SHADER) - controls how quickly motion calms down and dye fades
// on its own, independent of the (otherwise energy-conserving) advection/
// projection math. First-guess values, meant to be tuned live.
const VELOCITY_DISSIPATION = 0.2;
const DYE_DISSIPATION = 0.5;
// Vorticity-confinement strength - the "how swirly" knob. Re-injects the
// small-scale rotational detail advection alone tends to smooth away.
const CURL_STRENGTH = 12;
// Splat footprint, in UV units (post aspect-ratio correction - see
// SPLAT_SHADER) - shared by both the dye and velocity splats.
const SPLAT_RADIUS = 0.0022;
// Converts a ball's measured screen velocity (UV/sec) into the "texels of
// the sim grid per second" unit the velocity texture is stored in (see
// ADVECTION_SHADER's `texelSize` use) - simWidth/simHeight is exactly that
// conversion factor. This extra multiplier is purely an artistic strength
// knob on top of that, meant to be tuned live once this is on screen. This
// is the main knob for how fast the resulting splats visibly propagate/
// spread outward across the screen - it scales the velocity impulse
// injected alongside each splat's dye, so a lower value pushes the fluid
// outward more gently/slowly without changing how much dye color lands or
// how swirly it looks once it's moving (see CURL_STRENGTH for that).
// VELOCITY_DISSIPATION is the other lever on "how far it travels before
// stopping" - unlike this, it calms *existing* motion down faster rather
// than injecting less of it to begin with.
const SPLAT_FORCE_SCALE = 0.3;
// A ball moving at (or above) this many screen px/sec, smoothed, splats at
// full strength; slower balls splat proportionally less, and a
// resting/held ball (smoothed speed ~0) stops adding anything at all.
const SPEED_REFERENCE = 1400;
const SPEED_SMOOTHING_SECONDS = 0.1;
// Below this, skip splatting entirely rather than doing GPU work for an
// imperceptible contribution.
const MIN_SPLAT_STRENGTH = 0.02;
const MAX_DT = 0.1; // Matches Renderer/Game/App's own big-frame-gap clamp.

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 texelSize;
void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Used only for the final dye -> canvas blit (see display()). Derives
// alpha from how bright the dye actually is at each pixel, rather than
// the stored alpha channel - which SPLAT_SHADER (see below) always drives
// to 1 the instant any dye lands nearby, however faint. Sampling that
// stored alpha directly here would make even barely-tinted pixels fully
// opaque, painting over Renderer's true background with solid black
// wherever the sim has "touched" a pixel but not yet colored it.
const COPY_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 fragColor;
void main () {
    vec3 color = texture(uTexture, vUv).rgb;
    float alpha = clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0);
    fragColor = vec4(color, alpha);
}
`;

const SPLAT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
out vec4 fragColor;
void main () {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture(uTarget, vUv).xyz;
    fragColor = vec4(base + splat, 1.0);
}
`;

// Semi-Lagrangian advection - shared by both the self-advected velocity
// field and the dye field advected through it (uSource is the field being
// moved; uVelocity is always the velocity field driving the motion, which
// for the velocity pass itself means uSource === uVelocity).
const ADVECTION_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
out vec4 fragColor;
void main () {
    vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
    vec4 result = texture(uSource, coord);
    fragColor = result / (1.0 + dissipation * dt);
}
`;

const CURL_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main () {
    float L = texture(uVelocity, vL).y;
    float R = texture(uVelocity, vR).y;
    float T = texture(uVelocity, vT).x;
    float B = texture(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`;

const VORTICITY_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
out vec4 fragColor;
void main () {
    float L = texture(uCurl, vL).x;
    float R = texture(uCurl, vR).x;
    float T = texture(uCurl, vT).x;
    float B = texture(uCurl, vB).x;
    float C = texture(uCurl, vUv).x;

    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;

    vec2 velocity = texture(uVelocity, vUv).xy;
    velocity += force * dt;
    fragColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}
`;

const DIVERGENCE_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main () {
    float L = texture(uVelocity, vL).x;
    float R = texture(uVelocity, vR).x;
    float T = texture(uVelocity, vT).y;
    float B = texture(uVelocity, vB).y;

    vec2 C = texture(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }

    fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
`;

// One Jacobi relaxation step toward solving the pressure Poisson equation
// (Laplacian(pressure) = divergence) - run PRESSURE_ITERATIONS times.
const PRESSURE_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
out vec4 fragColor;
void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float T = texture(uPressure, vT).x;
    float B = texture(uPressure, vB).x;
    float divergence = texture(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const GRADIENT_SUBTRACT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float T = texture(uPressure, vT).x;
    float B = texture(uPressure, vB).x;
    vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
    fragColor = vec4(velocity, 0.0, 1.0);
}
`;

/** '#rrggbb' -> [r, g, b] in 0-1. */
function hexToRgb01(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`FluidSimulation shader compile error: ${info}`);
    }
    return shader;
}

/** Compiled program + a name->location map for every active uniform, so call sites never call getUniformLocation directly. */
class Program {
    constructor(gl, vertexSource, fragmentSource) {
        this.gl = gl;
        this.program = gl.createProgram();
        gl.attachShader(this.program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(this.program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(this.program);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            throw new Error(`FluidSimulation program link error: ${gl.getProgramInfoLog(this.program)}`);
        }

        this.uniforms = {};
        const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(this.program, i);
            this.uniforms[info.name] = gl.getUniformLocation(this.program, info.name);
        }
    }

    bind() {
        this.gl.useProgram(this.program);
    }
}

function bindTexture(gl, unit, texture) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    return unit;
}

function createFBO(gl, width, height, internalFormat, type) {
    const texture = gl.createTexture();
    bindTexture(gl, 0, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return { texture, fbo, width, height };
}

/** Ping-ponged pair of same-sized FBOs - .read/.write swap each time a pass writes a new version of this field. */
function createDoubleFBO(gl, width, height, internalFormat, type) {
    let a = createFBO(gl, width, height, internalFormat, type);
    let b = createFBO(gl, width, height, internalFormat, type);
    return {
        width,
        height,
        get read() { return a; },
        get write() { return b; },
        swap() {
            const temp = a;
            a = b;
            b = temp;
        },
    };
}

function clearFBO(gl, fbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.viewport(0, 0, fbo.width, fbo.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
}

/** Larger grid dimension = baseResolution; the other follows the canvas's own aspect ratio. */
function computeResolution(baseResolution, width, height) {
    const aspect = width / height;
    if (aspect < 1) {
        return { width: Math.max(1, Math.round(baseResolution * aspect)), height: baseResolution };
    }
    return { width: baseResolution, height: Math.max(1, Math.round(baseResolution / aspect)) };
}

export default class FluidSimulation {
    /**
     * Feature-detects everything this needs (WebGL2 plus a floating-point-
     * renderable format) and returns null on any failure, so callers (see
     * Renderer) can fall back to the older bokeh effect with a single
     * truthiness check and no separate device-sniffing logic.
     */
    static tryCreate() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl2', {
                alpha: true,
                depth: false,
                stencil: false,
                antialias: false,
                preserveDrawingBuffer: false,
            });
            if (!gl) return null;

            // Always target half-float (never full 32-bit float) render
            // targets - either extension below enables rendering to
            // RGBA16F, and unlike RGBA32F, sampling a half-float texture
            // with linear filtering (see createFBO) is guaranteed by core
            // WebGL2 without also needing OES_texture_float_linear (which
            // isn't universal). Half-float's precision is already far
            // more than this effect needs.
            const hasFloatRenderTarget = gl.getExtension('EXT_color_buffer_float')
                || gl.getExtension('EXT_color_buffer_half_float');
            if (!hasFloatRenderTarget) return null;
            const internalFormat = gl.RGBA16F;
            const type = gl.HALF_FLOAT;

            // Some devices report the extension but still can't actually
            // complete a framebuffer in this format - confirm for real
            // before committing to this path over the bokeh fallback.
            const probe = createFBO(gl, 4, 4, internalFormat, type);
            const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            gl.deleteFramebuffer(probe.fbo);
            gl.deleteTexture(probe.texture);
            if (!complete) return null;

            return new FluidSimulation(canvas, gl, internalFormat, type);
        } catch (err) {
            return null;
        }
    }

    constructor(canvas, gl, internalFormat, type) {
        this.canvas = canvas;
        this.gl = gl;
        this.internalFormat = internalFormat;
        this.type = type;

        const vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
        const indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        this.copyProgram = new Program(gl, VERTEX_SHADER, COPY_SHADER);
        this.splatProgram = new Program(gl, VERTEX_SHADER, SPLAT_SHADER);
        this.advectionProgram = new Program(gl, VERTEX_SHADER, ADVECTION_SHADER);
        this.curlProgram = new Program(gl, VERTEX_SHADER, CURL_SHADER);
        this.vorticityProgram = new Program(gl, VERTEX_SHADER, VORTICITY_SHADER);
        this.divergenceProgram = new Program(gl, VERTEX_SHADER, DIVERGENCE_SHADER);
        this.pressureProgram = new Program(gl, VERTEX_SHADER, PRESSURE_SHADER);
        this.gradientSubtractProgram = new Program(gl, VERTEX_SHADER, GRADIENT_SUBTRACT_SHADER);

        this.simWidth = 0;
        this.simHeight = 0;
        this.dyeWidth = 0;
        this.dyeHeight = 0;
        this.velocity = null;
        this.dye = null;
        this.divergence = null;
        this.curl = null;
        this.pressure = null;

        // Per-ball-id {u, v, speed} - same shape of problem as Renderer's
        // bokehBlobs, but far simpler: no eased "lag" position or pulse
        // phase is needed here, since the fluid's own advection already
        // produces organic trailing/swirling motion on its own.
        this.ballTrackers = new Map();
        this.lastTime = null;
    }

    /** Match internal grid resolutions (and the offscreen canvas's own backing size) to the display size. Cheap to call redundantly - only reallocates when a dimension actually changed. */
    resize(cssWidth, cssHeight) {
        const width = Math.max(1, Math.round(cssWidth));
        const height = Math.max(1, Math.round(cssHeight));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        const gl = this.gl;
        const sim = computeResolution(SIM_RESOLUTION, width, height);
        const dye = computeResolution(DYE_RESOLUTION, width, height);

        if (sim.width !== this.simWidth || sim.height !== this.simHeight) {
            this.simWidth = sim.width;
            this.simHeight = sim.height;
            this.velocity = createDoubleFBO(gl, sim.width, sim.height, this.internalFormat, this.type);
            this.divergence = createFBO(gl, sim.width, sim.height, this.internalFormat, this.type);
            this.curl = createFBO(gl, sim.width, sim.height, this.internalFormat, this.type);
            this.pressure = createDoubleFBO(gl, sim.width, sim.height, this.internalFormat, this.type);
        }
        if (dye.width !== this.dyeWidth || dye.height !== this.dyeHeight) {
            this.dyeWidth = dye.width;
            this.dyeHeight = dye.height;
            this.dye = createDoubleFBO(gl, dye.width, dye.height, this.internalFormat, this.type);
        }
    }

    /** Clears every buffer to fully transparent and drops per-ball tracking - call this wherever a fresh run shouldn't inherit a previous one's color/motion (see Renderer's bokehBlobs.clear() call sites). */
    reset() {
        this.ballTrackers.clear();
        this.lastTime = null;
        if (!this.velocity) return;
        for (const fbo of [
            this.velocity.read, this.velocity.write,
            this.dye.read, this.dye.write,
            this.divergence, this.curl,
            this.pressure.read, this.pressure.write,
        ]) {
            clearFBO(this.gl, fbo);
        }
    }

    /**
     * One frame: splat dye/velocity for whichever balls are moving fast
     * enough to matter, step the fluid, and render the result into
     * `this.canvas`. `balls` is `{ id, x, y, color }[]` in screen pixels
     * (Renderer maps world -> screen before calling this - see there).
     *
     * `active` (a plain boolean - see Renderer, which derives it from
     * `bokehIntensity > 0`) gates only whether *new* splats go in this
     * frame, never whether the sim keeps stepping - it's passed to
     * applySplats alone, not step. `step` always runs regardless (as long
     * as there's a `dt` to advance by), so whatever dye/motion is already
     * in the buffer keeps advecting and dissipating away on its own
     * (VELOCITY_DISSIPATION/DYE_DISSIPATION) the entire time `active` is
     * false, rather than being frozen mid-motion. That distinction matters
     * because `active` can go false more than once per game - not just
     * before the very first fade-in, but again any time Soundtrack's own
     * clean-streak progress gets reset by a mismatch (see
     * Soundtrack.resetProgression) - and freezing a swirling fluid
     * instantly mid-frame reads as a glitch, while letting it keep
     * settling/dissipating while alpha *also* fades it out reads as one
     * continuous, intentional-looking fade.
     *
     * Splats themselves, when they do go in, are never scaled by
     * intensity the way drawBokeh's `intensity` scales its blobs' alpha -
     * they always go in at full strength (scaled only by how fast that
     * ball is actually moving). The dye buffer's own dissipation reaches
     * "steady state" within a second or two regardless of how slowly some
     * external intensity value creeps up, so gating splat *strength* by
     * that same slow-moving intensity doesn't produce a slow *visible*
     * fade - it just pops up to whatever the current intensity's steady
     * state is within a couple of seconds, however small that intensity
     * happens to be. Any fade-in duration instead belongs entirely to
     * Renderer's own compositing step (a plain ctx.globalAlpha on the
     * drawImage call), which has no such lag - `active` gating new splats
     * outright is just what keeps the sim from silently building up to
     * that same steady state well before the alpha fade even starts.
     *
     * A fully empty `balls` (no juggling happening at all - e.g. the
     * title screen) is the one thing that does fully reset the
     * simulation - unlike bokeh (which repaints from nothing every frame
     * regardless), this sim's dye buffer is persistent GPU state that
     * would otherwise still be sitting there, stale, whenever juggling
     * starts again.
     */
    render(balls, active = true) {
        if (!this.velocity) return; // resize() hasn't run yet

        const now = performance.now();
        const dt = Math.min(this.lastTime != null ? (now - this.lastTime) / 1000 : 0, MAX_DT);
        this.lastTime = now;

        if (!balls || balls.length === 0) {
            this.reset();
            this.display(); // otherwise the canvas would keep showing the last frame drawn before it emptied out
            return;
        }

        if (active) this.applySplats(balls, dt);
        if (dt > 0) this.step(dt);
        this.display();
    }

    applySplats(balls, dt) {
        if (!balls || balls.length === 0 || dt <= 0) return;

        const seenIds = new Set();
        const smoothingRate = Math.min(1, dt / SPEED_SMOOTHING_SECONDS);
        const aspectRatio = this.dyeWidth / this.dyeHeight;

        for (const ball of balls) {
            if (ball.id == null) continue;
            seenIds.add(ball.id);

            const u = ball.x / this.canvas.width;
            const v = 1 - ball.y / this.canvas.height; // screen y is top-down; UV v is bottom-up

            let tracker = this.ballTrackers.get(ball.id);
            if (!tracker) {
                this.ballTrackers.set(ball.id, { u, v, speed: 0 });
                continue; // no meaningful delta on the first frame we see this id
            }

            const du = u - tracker.u;
            const dv = v - tracker.v;
            const instantSpeed = Math.hypot(du * this.canvas.width, dv * this.canvas.height) / dt;
            tracker.speed += (instantSpeed - tracker.speed) * smoothingRate;

            const strength = Math.min(tracker.speed / SPEED_REFERENCE, 1);

            if (strength > MIN_SPLAT_STRENGTH) {
                const [r, g, b] = hexToRgb01(ball.color);
                this.splat(this.dye, u, v, aspectRatio, [r * strength, g * strength, b * strength]);
                this.splat(this.velocity, u, v, aspectRatio, [
                    (du / dt) * this.simWidth * SPLAT_FORCE_SCALE * strength,
                    (dv / dt) * this.simHeight * SPLAT_FORCE_SCALE * strength,
                    0,
                ]);
            }

            tracker.u = u;
            tracker.v = v;
        }

        for (const id of this.ballTrackers.keys()) {
            if (!seenIds.has(id)) this.ballTrackers.delete(id);
        }
    }

    splat(target, u, v, aspectRatio, color) {
        const gl = this.gl;
        this.splatProgram.bind();
        gl.uniform1i(this.splatProgram.uniforms.uTarget, bindTexture(gl, 0, target.read.texture));
        gl.uniform1f(this.splatProgram.uniforms.aspectRatio, aspectRatio);
        gl.uniform2f(this.splatProgram.uniforms.point, u, v);
        gl.uniform3f(this.splatProgram.uniforms.color, color[0], color[1], color[2]);
        gl.uniform1f(this.splatProgram.uniforms.radius, SPLAT_RADIUS);
        this.blit(target.write);
        target.swap();
    }

    /** The Stable Fluids pipeline: vorticity confinement, then a pressure projection to make the flow ~incompressible, then advect velocity and dye through the result. */
    step(dt) {
        const gl = this.gl;
        gl.disable(gl.BLEND);
        const simTexelSize = [1 / this.simWidth, 1 / this.simHeight];

        this.curlProgram.bind();
        gl.uniform2f(this.curlProgram.uniforms.texelSize, ...simTexelSize);
        gl.uniform1i(this.curlProgram.uniforms.uVelocity, bindTexture(gl, 0, this.velocity.read.texture));
        this.blit(this.curl);

        this.vorticityProgram.bind();
        gl.uniform2f(this.vorticityProgram.uniforms.texelSize, ...simTexelSize);
        gl.uniform1i(this.vorticityProgram.uniforms.uVelocity, bindTexture(gl, 0, this.velocity.read.texture));
        gl.uniform1i(this.vorticityProgram.uniforms.uCurl, bindTexture(gl, 1, this.curl.texture));
        gl.uniform1f(this.vorticityProgram.uniforms.curl, CURL_STRENGTH);
        gl.uniform1f(this.vorticityProgram.uniforms.dt, dt);
        this.blit(this.velocity.write);
        this.velocity.swap();

        this.divergenceProgram.bind();
        gl.uniform2f(this.divergenceProgram.uniforms.texelSize, ...simTexelSize);
        gl.uniform1i(this.divergenceProgram.uniforms.uVelocity, bindTexture(gl, 0, this.velocity.read.texture));
        this.blit(this.divergence);

        clearFBO(gl, this.pressure.read);

        this.pressureProgram.bind();
        gl.uniform2f(this.pressureProgram.uniforms.texelSize, ...simTexelSize);
        gl.uniform1i(this.pressureProgram.uniforms.uDivergence, bindTexture(gl, 0, this.divergence.texture));
        for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(this.pressureProgram.uniforms.uPressure, bindTexture(gl, 1, this.pressure.read.texture));
            this.blit(this.pressure.write);
            this.pressure.swap();
        }

        this.gradientSubtractProgram.bind();
        gl.uniform2f(this.gradientSubtractProgram.uniforms.texelSize, ...simTexelSize);
        gl.uniform1i(this.gradientSubtractProgram.uniforms.uPressure, bindTexture(gl, 0, this.pressure.read.texture));
        gl.uniform1i(this.gradientSubtractProgram.uniforms.uVelocity, bindTexture(gl, 1, this.velocity.read.texture));
        this.blit(this.velocity.write);
        this.velocity.swap();

        this.advectionProgram.bind();
        gl.uniform2f(this.advectionProgram.uniforms.texelSize, ...simTexelSize);
        gl.uniform1f(this.advectionProgram.uniforms.dt, dt);
        const selfVelocityUnit = bindTexture(gl, 0, this.velocity.read.texture);
        gl.uniform1i(this.advectionProgram.uniforms.uVelocity, selfVelocityUnit);
        gl.uniform1i(this.advectionProgram.uniforms.uSource, selfVelocityUnit);
        gl.uniform1f(this.advectionProgram.uniforms.dissipation, VELOCITY_DISSIPATION);
        this.blit(this.velocity.write);
        this.velocity.swap();

        gl.uniform1i(this.advectionProgram.uniforms.uVelocity, bindTexture(gl, 0, this.velocity.read.texture));
        gl.uniform1i(this.advectionProgram.uniforms.uSource, bindTexture(gl, 1, this.dye.read.texture));
        gl.uniform1f(this.advectionProgram.uniforms.dissipation, DYE_DISSIPATION);
        this.blit(this.dye.write);
        this.dye.swap();
    }

    display() {
        const gl = this.gl;
        this.copyProgram.bind();
        gl.uniform1i(this.copyProgram.uniforms.uTexture, bindTexture(gl, 0, this.dye.read.texture));
        this.blit(null);
    }

    /** Draws the shared full-screen quad into `target` (an FBO wrapper) or the canvas itself (target == null). */
    blit(target) {
        const gl = this.gl;
        if (target == null) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.viewport(0, 0, target.width, target.height);
        }
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
}
