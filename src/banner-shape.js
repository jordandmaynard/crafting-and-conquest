// A banner's shape (see units-render.js bannerVertices): its cloth and point one part, with its shoulders where the
// point starts. There's one shape for each of BANNER_STEPS points; bannerShape(point) names the one for a point
// `point` of the banner's whole length (0 to 1).
export const BANNER_STEPS = 32;
export const bannerShape = (point) => `banner${Math.max(0, Math.min(BANNER_STEPS - 1, Math.floor(point * BANNER_STEPS)))}`;
