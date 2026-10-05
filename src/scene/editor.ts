import { mat4, vec3 } from "gl-matrix";
import type { SceneDescription } from "./types";
import { lavaEmission } from "./textured-materials";

export const sceneControlIds = [
  "object-scale",
  "object-x",
  "object-y",
  "object-z",
  "object-rotation",
  "object-rotation-x",
  "object-rotation-z",
  "light-power",
  "light-size",
  "light-x",
  "light-z",
  "wall-neutral",
  "wall-red",
  "wall-green",
  "ior",
  "absorption",
  "albedo",
] as const;
export type SceneControls = Record<(typeof sceneControlIds)[number], number>;
export const textureControlIds = [
  "texture-scale",
  "texture-turbulence",
  "texture-width",
  "texture-coating",
  "lava-power",
  "lava-temperature",
] as const;
export type TextureControls = Record<
  (typeof textureControlIds)[number],
  number
>;

export function applyTextureControls(
  scene: SceneDescription,
  v: TextureControls,
): void {
  const material = scene.materials[4]!;
  if (material.type !== "marble" && material.type !== "lava") return;
  material.scale = v["texture-scale"];
  material.turbulence = v["texture-turbulence"];
  material.width = v["texture-width"];
  material.coating = v["texture-coating"];
  if (material.type === "lava") {
    material.emissionPower = v["lava-power"];
    Object.assign(material, lavaEmission(v["lava-temperature"]));
  }
}

/** Keep the editable solid inside the room; crossing a wall breaks medium boundaries. */
export function applySceneControls(
  scene: SceneDescription,
  v: SceneControls,
): void {
  const transform = mat4.create();
  mat4.rotateZ(transform, transform, ((v["object-rotation-z"] ?? 0) * Math.PI) / 180);
  mat4.rotateY(transform, transform, (v["object-rotation"] * Math.PI) / 180);
  mat4.rotateX(transform, transform, ((v["object-rotation-x"] ?? 0) * Math.PI) / 180);
  mat4.scale(transform, transform, [
    v["object-scale"],
    v["object-scale"],
    v["object-scale"],
  ]);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity],
    point = vec3.create();
  const mesh = scene.meshes[6]!;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    vec3.set(
      point,
      mesh.positions[i]!,
      mesh.positions[i + 1]!,
      mesh.positions[i + 2]!,
    );
    vec3.transformMat4(point, point, transform);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  for (const [axis, id] of [
    [0, "object-x"],
    [1, "object-y"],
    [2, "object-z"],
  ] as const) {
    const low =
        Math.ceil(((axis === 1 ? 0.001 : -0.999) - min[axis]!) * 100) / 100,
      high = Math.floor(((axis === 1 ? 1.98 : 0.999) - max[axis]!) * 100) / 100;
    if (low > high) throw new Error("Object does not fit inside the room");
    v[id] = Math.min(high, Math.max(low, v[id]));
    transform[12 + axis] = v[id];
  }
  scene.objects[6]!.transform = Array.from(transform);
  scene.meshes[5]!.positions = scene.meshes[5]!.positions.map((p, i) =>
    i % 3 === 1 ? p : (p * v["light-size"]) / 0.6,
  );
  const lightTransform = mat4.create();
  mat4.translate(lightTransform, lightTransform, [
    v["light-x"],
    0,
    v["light-z"],
  ]);
  scene.objects[5]!.transform = Array.from(lightTransform);
  const emitter = scene.materials[3]!;
  if (emitter.type === "emissive") {
    emitter.emission = [v["light-power"], v["light-power"], v["light-power"]];
    emitter.spectrum = emitter.spectrum!.map(([nm, power]) => [
      nm,
      (power * v["light-power"]) / 12,
    ]);
  }
  const neutral = scene.materials[0]!;
  if (neutral.type === "diffuse")
    neutral.reflectance = [
      v["wall-neutral"],
      v["wall-neutral"],
      v["wall-neutral"],
    ];
  for (const [index, id] of [
    [1, "wall-red"],
    [2, "wall-green"],
  ] as const) {
    const wall = scene.materials[index]!;
    if (wall.type === "diffuse") {
      wall.reflectance = wall.reflectance.map((p) => p * v[id]) as [
        number,
        number,
        number,
      ];
      wall.spectrum = wall.spectrum!.map(([nm, power]) => [nm, power * v[id]]);
    }
  }
  const object = scene.materials[4]!;
  if (object.type === "dielectric") {
    if (object.iorModel !== "nbk7") object.ior = v.ior;
    object.absorption = object.absorption.map((p) => p * v.absorption) as [
      number,
      number,
      number,
    ];
    object.absorptionSpectrum = object.absorptionSpectrum?.map(
      ([nm, power]) => [nm, power * v.absorption],
    );
  } else if (object.type === "diffuse")
    object.reflectance = [v.albedo, v.albedo, v.albedo];
}
