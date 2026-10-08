import { vec3 } from 'gl-matrix';
import type { CameraDescription, Vec3 } from './types';

export function cameraBasis(camera: CameraDescription): { eye: Vec3; forward: Vec3; right: Vec3; up: Vec3 } {
  if (![...camera.position, ...camera.target, ...camera.up, camera.verticalFov].every(Number.isFinite) || camera.verticalFov <= 0 || camera.verticalFov >= 179) throw new Error('Invalid camera');
  const forward = vec3.subtract(vec3.create(), camera.target, camera.position);
  if (vec3.length(forward) < 1e-8) throw new Error('Camera position and target must differ');
  vec3.normalize(forward, forward);
  const right = vec3.cross(vec3.create(), forward, camera.up);
  if (vec3.length(right) < 1e-8) throw new Error('Camera up must not be parallel to its direction');
  vec3.normalize(right, right);
  const up = vec3.cross(vec3.create(), right, forward);
  const scale = Math.tan(camera.verticalFov * Math.PI / 360);
  vec3.scale(right, right, scale); vec3.scale(up, up, scale);
  return { eye: [...camera.position], forward: Array.from(forward) as Vec3, right: Array.from(right) as Vec3, up: Array.from(up) as Vec3 };
}

export const CAMERA_DISTANCE_MIN = 0.25;
export const CAMERA_DISTANCE_MAX = 100;
export const FOCUS_DISTANCE_MIN = 0.01;
export const FOCUS_DISTANCE_MAX = 1000;
export const logDistance = (fraction: number, min: number, max: number): number => min * (max / min) ** fraction;
export const distanceFraction = (distance: number, min: number, max: number): number => Math.log(distance / min) / Math.log(max / min);
export function cameraOptics(camera: CameraDescription) {
  const d = camera.depthOfField ?? {};
  const diameter = d.apertureDiameter ?? 0.02, mode = d.focusMode ?? 'target', shape = d.apertureShape ?? 'circle';
  const manual = d.focusDistance ?? Math.max(FOCUS_DISTANCE_MIN, Math.min(FOCUS_DISTANCE_MAX, Math.hypot(...camera.target.map((v, i) => v - camera.position[i]!))));
  const blades = d.blades ?? 6, rotation = d.rotation ?? 0;
  if (
    (d.enabled !== undefined && typeof d.enabled !== 'boolean') ||
    !Number.isFinite(diameter) || diameter < 0 || diameter > .1 ||
    !Number.isFinite(manual) || manual < FOCUS_DISTANCE_MIN || manual > FOCUS_DISTANCE_MAX ||
    !Number.isInteger(blades) || blades < 3 || blades > 12 ||
    !Number.isFinite(rotation) || rotation < 0 || rotation > 360 ||
    !['target','manual','point'].includes(mode) || !['circle','polygon'].includes(shape) ||
    (d.focusPoint && (d.focusPoint.length !== 3 || !d.focusPoint.every(Number.isFinite)))
  ) throw new Error('Invalid camera optics');
  const basis = cameraBasis(camera), point = mode === 'point' ? d.focusPoint ?? camera.target : camera.target;
  const projected = point.reduce((sum, v, i) => sum + (v - camera.position[i]!) * basis.forward[i]!, 0);
  return {
    active: !!d.enabled && diameter > 0,
    radius: d.enabled ? diameter / 2 : 0,
    distance: mode === 'manual' ? manual : Math.max(FOCUS_DISTANCE_MIN, projected),
    behind: mode !== 'manual' && projected <= 0,
    shape, blades, rotation,
  };
}
/** Equal-area disk or equal-area triangle fan of a regular polygon. */
export function sampleAperture(u: number, v: number, blades = 0, rotation = 0): [number, number] {
  const r = Math.sqrt(v), angle = rotation * Math.PI / 180;
  if (!blades) return [r * Math.cos(2 * Math.PI * u + angle), r * Math.sin(2 * Math.PI * u + angle)];
  const sector = u * blades, a = Math.floor(sector) * 2 * Math.PI / blades + angle, t = sector % 1, b = a + 2 * Math.PI / blades;
  return [r * ((1-t)*Math.cos(a)+t*Math.cos(b)), r * ((1-t)*Math.sin(a)+t*Math.sin(b))];
}
