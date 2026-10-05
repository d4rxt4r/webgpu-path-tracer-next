import type { SceneDescription, Vec3 } from './types';

export interface EnvironmentSettings {
  source: 'off' | 'color' | 'hdr';
  color: Vec3;
  strength: number;
  rotation: number;
  background: boolean;
  exposure: number;
  blur: number;
}
export const defaultEnvironment: EnvironmentSettings = {
  source: 'off', color: [1, 1, 1], strength: 1, rotation: 0,
  background: true, exposure: 0, blur: 0,
};

/** Visibility changes retain object indices used by the editor and medium IDs. */
export function arrangeScene(scene: SceneDescription, open: boolean, ground: boolean, lamp: boolean): void {
  for (let i = 0; i < 5; i++) scene.objects[i]!.visible = !open || (i === 0 && ground);
  scene.objects[5]!.visible = lamp;
  if (open && ground) scene.meshes[0]!.positions = scene.meshes[0]!.positions.map((v, i) => i % 3 === 1 ? v : v * 5);
  scene.lights = scene.lights.filter(light => scene.objects[light.object]!.visible !== false);
}
