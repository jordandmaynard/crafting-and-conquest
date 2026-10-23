// God-game camera: orbits freely about the vertical axis through its target, tilts between MIN_PITCH and
// MAX_PITCH, and zooms by distance. A narrow field of view keeps the "isometric" look while staying
// perspective; P toggles a true orthographic projection. Possessing a unit (fp), it looks out from the unit's eyes
// instead. World units are voxels, y up.

import { mat4, clamp } from './math.js';

export const CAMERA_TUNING = {
  fov: (30 * Math.PI) / 180,
  minPitch: (25 * Math.PI) / 180,
  maxPitch: (85 * Math.PI) / 180,
  minDistance: 40,
  maxDistance: 1400,
};

// Possessing a unit (see main.js): the camera at its eyes, looking where it looks (T > Possess).
export const POSSESS_TUNING = {
  fov: 70,          // vertical field of view (deg)
  near: 0.05,       // near plane (voxels): the eyes can come right up to a wall
  far: 1500,        // far plane (voxels)
  eyeUp: 0.03,      // the eyes, from the middle of the head: this far up
  eyeForward: 0.2,  // and this far forward (the head's front is 0.25)
  eyeHeight: 1.79,  // where the eyes are over the feet, steady (see headBob)
  headBob: 0.25,    // how much the eyes move with the head (0 steady at eyeHeight, 1 all its bob, lean and sway)
  headTurn: 0.6,    // how much the view turns with the head left and right (0 the way the body faces, 1 the head's)
  headNod: 0.25,    // and up and down with its nod
  pitch: -6,        // looking down by (deg; the head's nod on top)
  hideBody: 0,      // 0: only its head is left out; 1: all of it (and what it holds)
  smooth: 0.2,      // the view eases after the head over (s)
  oneHand: 1,       // a possessed worker swings its pickaxe, axe or shovel in its right hand alone, off to its side (0 both hands)
  oneHandSide: 0.35, // that hand this far out to its right from the middle (voxels; its shoulder is 0.37)
  armDrop: 0.12,    // its arms and what they hold drawn this much lower (voxels; out of the middle of the view)
  armOut: 0.06,     // and this much further out to its right
  armBack: 0,       // and this much further back
  fogStart: 60,     // distance fog starts at (voxels)
  dof: 0,           // depth of field (0 off, 1 on)
  focus: 20,        // and in focus at (voxels from the eyes)
  view: 60,         // stands in for the zoom distance (the minimap's view outline, ore chunks drawn)
};

export class Camera {
  constructor() {
    this.target = [250, 30, 250];
    this.yaw = Math.PI / 4;
    this.pitch = (40 * Math.PI) / 180;
    this.distance = 420;
    this.ortho = false;
    this.aspect = 1;
    this.fp = null; // first person: { eye, yaw, pitch } (possessing a unit), else orbiting
  }

  orbit(dYaw, dPitch) {
    const t = CAMERA_TUNING;
    this.yaw = (this.yaw + dYaw) % (Math.PI * 2);
    this.pitch = clamp(this.pitch + dPitch, t.minPitch, t.maxPitch);
  }

  zoom(factor) {
    this.distance = clamp(this.distance * factor, CAMERA_TUNING.minDistance, CAMERA_TUNING.maxDistance);
  }

  // Pans in the ground plane, in screen-aligned directions (right, forward), scaled by zoom.
  pan(right, forward, bounds) {
    const s = this.distance;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.target[0] = clamp(this.target[0] + (cos * right - sin * forward) * s, 0, bounds[0]);
    this.target[2] = clamp(this.target[2] + (-sin * right - cos * forward) * s, 0, bounds[2]);
  }

  eye() {
    if (this.fp) return this.fp.eye;
    const c = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * c * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * c * Math.cos(this.yaw),
    ];
  }

  matrices() {
    if (this.fp) {
      const P = POSSESS_TUNING, { eye, yaw, pitch } = this.fp;
      const look = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const view = mat4.lookAt(eye, eye.map((v, i) => v + look[i]), [0, 1, 0]);
      const proj = mat4.perspective((P.fov * Math.PI) / 180, this.aspect, Math.max(0.005, P.near), Math.max(P.far, P.near + 1));
      const viewProj = mat4.multiply(proj, view);
      return { eye, view, proj, viewProj, invViewProj: mat4.invert(viewProj), halfH: 1 };
    }
    const eye = this.eye();
    const view = mat4.lookAt(eye, this.target, [0, 1, 0]);
    const t = CAMERA_TUNING;
    const near = this.ortho ? 1 : Math.max(1, this.distance * 0.05);
    const far = this.distance + 2000;
    const halfH = this.distance * Math.tan(t.fov / 2);
    const proj = this.ortho
      ? mat4.ortho(halfH * this.aspect, halfH, near, far)
      : mat4.perspective(t.fov, this.aspect, near, far);
    const viewProj = mat4.multiply(proj, view);
    return { eye, view, proj, viewProj, invViewProj: mat4.invert(viewProj), halfH };
  }

  // World-space ray through a point in normalised device coordinates.
  ray(invViewProj, ndcX, ndcY) {
    const a = mat4.project(invViewProj, ndcX, ndcY, 0);
    const b = mat4.project(invViewProj, ndcX, ndcY, 1);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...d);
    return { origin: a, dir: d.map((v) => v / l) };
  }
}
