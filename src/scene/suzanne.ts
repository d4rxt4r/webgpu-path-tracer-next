import { loadBuiltinObj } from '../assets/builtin-obj';
import { cornellScene } from './cornell';
import type { SphereMaterial } from './cornell';
import type { SceneDescription } from './types';

/** Final scene: the same 2m Cornell box and source, one glass solid centered at (0,1,0). */
export async function suzanneScene(material:SphereMaterial='nbk7'):Promise<SceneDescription> {
  const scene=cornellScene(material);
  const source=await loadBuiltinObj('suzanne');
  scene.meshes[6]=source.mesh;
  const glass=scene.materials[4]!;
  if(glass.type==='dielectric') glass.thin=!source.solid;
  scene.objects[6]!.transform=[1,0,0,0,0,1,0,0,0,0,1,0,0,1,0,1];
  return scene;
}
