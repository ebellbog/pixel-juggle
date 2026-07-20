/**
 * Hinged two-link kinematics for the title-screen decorative orbs (see
 * .menu-orb in index.less). Each orb's center sits at the free end of a
 * short "outer" arm whose pivot is the tip of a longer "inner" arm; the
 * inner arm pivots on #pattern-picker's center. The arms themselves are
 * never drawn — only the orb positions they imply.
 *
 * Shared arm lengths/velocities apply to every orb; starting phases are
 * spaced evenly (phaseSpacing, default 120°) around the pivot. Outer
 * velocity is relative to the inner arm.
 */
export const MENU_ORB_LINKAGE = {
    innerLength: 90,
    outerLength: 30,
    innerAngularVelocity: 0.1,
    outerAngularVelocity: 0.5,
    orbCount: 3,
    baseInnerPhase: -Math.PI / 2,
    outerPhase: 0,
    phaseSpacing: (2 * Math.PI) / 3,
};

function orbPhases(index, config) {
    return {
        innerPhase: config.baseInnerPhase + index * config.phaseSpacing,
        outerPhase: config.outerPhase,
    };
}

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

function linkageArm(config) {
    return {
        innerLength: config.innerLength,
        outerLength: config.outerLength,
        innerAngularVelocity: config.innerAngularVelocity,
        outerAngularVelocity: config.outerAngularVelocity,
    };
}

/** Positions at time `t` for every orb — used by apply() and START_POSITIONS. */
export function getMenuOrbPositionsAt(t, config = MENU_ORB_LINKAGE) {
    const arm = linkageArm(config);
    const positions = [];
    for (let i = 0; i < config.orbCount; i++) {
        positions.push(linkagePosition(t, arm, orbPhases(i, config)));
    }
    return positions;
}

/**
 * t = 0 rest positions — keep the transform fallbacks on each .menu-orb--*
 * in index.less in sync whenever MENU_ORB_LINKAGE arm lengths/phases change.
 */
export const MENU_ORB_START_POSITIONS = getMenuOrbPositionsAt(0);

/**
 * Positions every .menu-orb under #pattern-picker each frame while the menu
 * is showing (see App.setMode). Stops when the player leaves the title
 * screen so the loop isn't running under demo/game.
 */
export default class MenuOrbAnimation {
    constructor(element, config = MENU_ORB_LINKAGE) {
        this.element = element;
        this.config = config;
        this.orbElements = element.querySelectorAll('.menu-orb');
        this.rafId = null;
        this.startTime = null;
        this.reducedMotion = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.apply(0);
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
        const arm = linkageArm(this.config);
        const count = Math.min(this.orbElements.length, this.config.orbCount);

        for (let i = 0; i < count; i++) {
            const pos = linkagePosition(t, arm, orbPhases(i, this.config));
            this.orbElements[i].style.transform =
                `translate(calc(-50% + ${pos.x.toFixed(2)}px), calc(-50% + ${pos.y.toFixed(2)}px))`;
        }
    }
}
