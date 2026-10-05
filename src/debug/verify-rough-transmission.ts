import { shellScene } from "./shell-fixture";
import { renderSppm } from "./render-sppm";

/** A bright emitter behind two interfaces must remain visible at small roughness. */
export async function verifyRoughTransmission() {
  const results = [];
  for (const thin of [false, true]) for (const roughness of [0, 0.01, 0.1, 0.35]) {
    const scene = shellScene("reference");
    const material = scene.materials[0]!;
    if (material.type !== "dielectric") throw new Error("Unexpected material");
    material.absorption = [0, 0, 0]; material.roughness = roughness; material.thin = thin;
    const result = await renderSppm(scene, { width: 1, height: 1, mode: "rgb", iterations: 128, photonsPerIteration: 128, photonBatchSize: 128, maxDepth: 8 });
    results.push({ thin, roughness, mean: result.pixels[0], errors: result.errors });
  }
  return results;
}
