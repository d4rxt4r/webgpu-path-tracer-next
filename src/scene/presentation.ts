import { suzanneScene } from "./suzanne";
import type { SphereMaterial } from "./cornell";
import type { SceneDescription } from "./types";

/** Artistic presentation preset; canonical N-BK7 validation scenes stay reproducible. */
export async function presentationScene(
  material: SphereMaterial = "blue-glass",
): Promise<SceneDescription> {
  const scene = await suzanneScene(material);
  scene.objects[3]!.material = 2;
  scene.objects[4]!.material = 1;
  return scene;
}
