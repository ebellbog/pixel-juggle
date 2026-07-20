/**
 * Hinged two-link kinematics for the title-screen decorative orbs (see
 * #pattern-picker::before/::after in index.less). Each orb's center sits
 * at the free end of a short "outer" arm whose pivot is the tip of a
 * longer "inner" arm; the inner arm pivots on #pattern-picker's center.
 * The arms themselves are never drawn — only the orb positions they imply.
 *
 * Shared arm lengths/velocities apply to both orbs; only the starting
 * phases differ so they begin on opposite sides of the picker. Outer
 * velocity is relative to the inner arm (same sign = same direction;
 * opposite sign = counter-rotation).
 */
export const MENU_ORB_LINKAGE = {
    innerLength: 90,
    outerLength: 30,
    innerAngularVelocity: .1,
    outerAngularVelocity: .5,
    orbs: {
        top: {
            innerPhase: -Math.PI / 2,
            outerPhase: 0,
        },
        bottom: {
            innerPhase: Math.PI / 2,
            outerPhase: 0, // extend straight down, mirroring top's outerPhase
        },
    },
};

function linkagePosition(t, arm, phases) {
    const theta1 = phases.innerPhase + arm.innerAngularVelocity * t;
    const theta2 = phases.outerPhase + arm.outerAngularVelocity * t;
    const innerX = arm.innerLength * Math.cos(theta1);
    const innerY = arm.innerLength * Math.sin(theta1);
    const heading = theta1 + theta2;
    return {
        x: innerX + arm.outerLength * Math.cos(heading),
        y: innerY + arm.outerLength * Math.sin(heading),
    };
}

/**
 * Drives --orb-* CSS variables on #pattern-picker each frame while the menu
 * is showing (see App.setMode). Stops automatically when the player leaves
 * the title screen so the loop isn't running under demo/game.
 */
export default class MenuOrbAnimation {
    constructor(element, config = MENU_ORB_LINKAGE) {
        this.element = element;
        this.config = config;
        this.rafId = null;
        this.startTime = null;
        this.reducedMotion = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    start() {
        this.apply(0);
        if (this.reducedMotion) return;
        if (this.rafId != null) return;
        this.startTime = performance.now();
        const tick = (now) => {
            this.apply((now - this.startTime) / 1000);
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    stop() {
        if (this.rafId != null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    apply(t) {
        const { innerLength, outerLength, innerAngularVelocity, outerAngularVelocity, orbs } = this.config;
        const arm = { innerLength, outerLength, innerAngularVelocity, outerAngularVelocity };
        const top = linkagePosition(t, arm, orbs.top);
        const bottom = linkagePosition(t, arm, orbs.bottom);
        const style = this.element.style;
        style.setProperty('--orb-top-x', `${top.x.toFixed(2)}px`);
        style.setProperty('--orb-top-y', `${top.y.toFixed(2)}px`);
        style.setProperty('--orb-bottom-x', `${bottom.x.toFixed(2)}px`);
        style.setProperty('--orb-bottom-y', `${bottom.y.toFixed(2)}px`);
    }
}
