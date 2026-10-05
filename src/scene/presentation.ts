import { loadOriginalSuzanne } from "../assets/suzanne-original";
import type { OriginalSuzanne } from "../assets/suzanne-original";
import { cornellScene } from "./cornell";
import type { SphereMaterial } from "./cornell";
import type { SceneDescription } from "./types";

/** Artistic presentation preset; canonical N-BK7 validation scenes stay reproducible. */
export async function presentationScene(
  material: SphereMaterial = "blue-glass",
  model?: OriginalSuzanne,
): Promise<SceneDescription> {
  const source = model ?? await loadOriginalSuzanne();
  const scene = cornellScene(material);
  scene.meshes[6] = source.mesh;
  scene.objects[6]!.transform = [1,0,0,0,0,1,0,0,0,0,1,0,0,1,0,1];
  const glass = scene.materials[4]!;
  if (glass.type === "dielectric") glass.thin = !source.solid;
  scene.objects[3]!.material = 2;
  scene.objects[4]!.material = 1;
  return scene;
}
