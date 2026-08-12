// Keep MOBILE_MEDIA_QUERY / MOBILE_LANDSCAPE_MEDIA_QUERY in sync with the
// @mobile / @mobile-landscape variables in src/less/mobile.less.
//
// Width-only breakpoints miss phones in landscape — an iPhone 12 is 390px
// wide in portrait but 844px wide when rotated. Touch-primary detection
// plus a small viewport in *either* dimension catches both orientations.

export const MOBILE_VIEWPORT_PX = 767;

/** Scale applied to menu-orb arm radii on mobile (innerLength/outerLength only). */
export const MENU_ORB_RADIUS_SCALE_MOBILE = 0.75;

export const MOBILE_MEDIA_QUERY =
    `(hover: none) and (pointer: coarse) and ((max-width: ${MOBILE_VIEWPORT_PX}px) or (max-height: ${MOBILE_VIEWPORT_PX}px))`;

export const MOBILE_LANDSCAPE_MEDIA_QUERY =
    `(orientation: landscape) and (hover: none) and (pointer: coarse) and (max-height: ${MOBILE_VIEWPORT_PX}px)`;

export function isMobileViewport() {
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/** MediaQueryList for isMobileViewport — use with 'change' to react to resize/rotation. */
export function mobileViewportMediaQuery() {
    if (typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(MOBILE_MEDIA_QUERY);
}

/** Returns 1 on desktop, MENU_ORB_RADIUS_SCALE_MOBILE on mobile viewports. */
export function menuOrbRadiusScale() {
    return isMobileViewport() ? MENU_ORB_RADIUS_SCALE_MOBILE : 1;
}
