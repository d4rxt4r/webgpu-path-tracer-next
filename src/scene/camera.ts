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
