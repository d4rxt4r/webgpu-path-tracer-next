import { loadSuzanne } from '../assets/suzanne';
import { cornellScene } from './cornell';
import type { SphereMaterial } from './cornell';
import type { SceneDescription } from './types';

/** Final scene: the same 2m Cornell box and source, one glass solid centered at (0,1,0). */
export async function suzanneScene(material:SphereMaterial='nbk7'):Promise<SceneDescription> {
  const scene=cornellScene(material);
  scene.meshes[6]=await loadSuzanne();
  scene.objects[6]!.transform=[1,0,0,0,0,1,0,0,0,0,1,0,0,1,0,1];
  return scene;
}
