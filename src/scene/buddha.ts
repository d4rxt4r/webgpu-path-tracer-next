import { mat4 } from "gl-matrix";
import { loadBuddha } from "../assets/buddha";
import { cornellScene } from "./cornell";
import type { SphereMaterial } from "./cornell";
import type { SceneDescription } from "./types";

export async function buddhaScene(
  material: SphereMaterial = "marble",
): Promise<SceneDescription> {
  const scene = cornellScene(material);
  scene.meshes[6] = await loadBuddha();
  scene.objects[6]!.transform = Array.from(
    mat4.fromTranslation(mat4.create(), [0, 0.86, 0]),
  );
  scene.objects[3]!.material = 2;
  scene.objects[4]!.material = 1;
  scene.camera.position = [0, 0.9, 3.7];
  scene.camera.target = [0, 0.9, 0];
  return scene;
}
