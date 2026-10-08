import { wearMetric } from "../scene/wear-space";
import { makeStructuredView } from "webgpu-utils";
import { mat4 } from "gl-matrix";
import { definitions } from "./pack";
import type { Bvh } from "./bvh";
import type { SceneDescription } from "../scene/types";
import { bakeSpectrum, cie, constantSpectrum } from "../transport/spectrum";
import { hasSurfaceWear, validateSurfaceWear, normalizeSurfaceWear, wearEffects, packWearEffect, effectActive } from "../scene/surface-wear";

export interface PackedTransport {
  materials: ArrayBuffer;
  lights: ArrayBuffer;
  lightCount: number;
  spectra: ArrayBuffer;
  spectralReady: boolean;
}
export function packTransport(
  description: SceneDescription,
  bvh: Bvh,
): PackedTransport {
  for (const [surface, object] of description.objects.entries()) {
    const surfaceMaterial = description.materials[object.material];
    if (surfaceMaterial?.type !== "dielectric" || surfaceMaterial.thin) continue;
    const shells = new Map<number, typeof bvh.triangles>();
    for (const triangle of bvh.triangles) {
      if (triangle.surface !== surface) continue;
      const id = triangle.boundary ?? surface + 1;
      if (!shells.has(id)) shells.set(id, []);
      shells.get(id)!.push(triangle);
    }
    for (const shell of shells.values()) {
      const edges = new Map<string, { count: number; orientation: number }>();
      let volume = 0;
      for (const t of shell) {
        volume += t.a[0] * (t.b[1] * t.c[2] - t.b[2] * t.c[1]) + t.a[1] * (t.b[2] * t.c[0] - t.b[0] * t.c[2]) + t.a[2] * (t.b[0] * t.c[1] - t.b[1] * t.c[0]);
        const vertices = [t.a.join(","), t.b.join(","), t.c.join(",")];
        for (let i = 0; i < 3; i++) {
          const a = vertices[i]!, b = vertices[(i + 1) % 3]!;
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          const edge = edges.get(key) ?? { count: 0, orientation: 0 };
          edge.count++; edge.orientation += a < b ? 1 : -1; edges.set(key, edge);
        }
      }
      if (volume <= 0 || !edges.size || [...edges.values()].some(edge => edge.count !== 2 || edge.orientation !== 0))
        throw new Error("Dielectric requires closed, outward-oriented shells");
    }
  }
  const materialDef = definitions.structs.Material!,
    lightDef = definitions.structs.LightTriangle!;
  const materials = new ArrayBuffer(
    materialDef.size * description.materials.length,
  );
  const spectra = new Float32Array(
    (3 + 2 * description.materials.length) * 471,
  );
  cie.forEach((channel, i) => spectra.set(channel, i * 471));
  let spectralReady = true;
  description.materials.forEach((material, i) => {
    const spectrumOffset = (3 + 2 * i) * 471,
      absorptionOffset = spectrumOffset + 471;
    if (material.type === "marble" || material.type === "lava") {
      const values = [
        material.scale,
        material.turbulence,
        material.width,
        material.coating,
        material.emissionPower,
      ];
      if (
        !values.every((v) => Number.isFinite(Math.fround(v))) ||
        material.scale <= 0 ||
        material.turbulence < 0 ||
        material.width <= 0 ||
        material.width > 1 ||
        material.coating < 0 ||
        material.coating > 0.95 ||
        material.emissionPower < 0 ||
        !material.reflectance.every(
          (v) => Number.isFinite(v) && v >= 0 && v <= 1,
        ) ||
        !material.secondary.every(
          (v) =>
            Number.isFinite(Math.fround(v)) &&
            v >= 0 &&
            (material.type === "lava" || v <= 1),
        )
      )
        throw new Error("Invalid textured material");
      spectra.set(bakeSpectrum(material.spectrum, true), spectrumOffset);
      spectra.set(
        bakeSpectrum(material.secondarySpectrum, material.type === "marble"),
        absorptionOffset,
      );
      const objects = description.objects.filter(
        (object) => object.material === i,
      );
      // One object-local transform per material. Shared texture instances must agree.
      if (
        objects.some((object) =>
          object.transform.some(
            (value, axis) => value !== objects[0]!.transform[axis],
          ),
        )
      )
        throw new Error(
          "Textured instances require separate material descriptions",
        );
      const worldToTexture = mat4.create();
      if (objects[0] && !mat4.invert(worldToTexture, objects[0].transform))
        throw new Error("Singular texture transform");
      makeStructuredView(materialDef, materials, i * materialDef.size).set({
        color: material.reflectance,
        kind: material.type === "marble" ? 3 : 4,
        absorption: material.secondary,
        ior: material.emissionPower,
        spectrumOffset,
        absorptionOffset,
        textureParams: [
          material.scale,
          material.turbulence,
          material.width,
          material.coating,
        ],
        worldToTexture,
      });
      return;
    }
    const color =
      material.type === "dielectric"
        ? material.absorption
        : material.type === "diffuse"
          ? material.reflectance
          : material.emission;
    const table =
      material.type === "dielectric"
        ? material.absorptionSpectrum
        : material.spectrum;
    const constant = color.every((v) => v === color[0]);
    if (!table && !constant) spectralReady = false;
    const dense = bakeSpectrum(
      table ?? constantSpectrum(constant ? color[0] : 0),
      material.type === "diffuse",
    );
    spectra.set(
      dense,
      material.type === "dielectric" ? absorptionOffset : spectrumOffset,
    );
    if (material.type === "dielectric") {
      if (material.surfaceWear) validateSurfaceWear(material.surfaceWear);
      if (
        !Number.isFinite(Math.fround(material.ior)) ||
        material.ior < 1 ||
        !material.absorption.every(
          (v) => Number.isFinite(Math.fround(v)) && v >= 0,
        )
      )
        throw new Error("Invalid dielectric material");
      if (
        material.iorModel &&
        !["constant", "nbk7", "cauchy"].includes(material.iorModel)
      )
        throw new Error("Invalid IOR model");
      const roughness = material.roughness ?? 0;
      const transmission = material.transmission ?? [1, 1, 1];
      if (!Number.isFinite(roughness) || roughness < 0 || roughness > 1 ||
          !transmission.every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
          (material.iorModel === "cauchy" && (!material.cauchy || !material.cauchy.every(v => Number.isFinite(Math.fround(v))) || material.cauchy[1] < 0 || material.cauchy[0] + material.cauchy[1] / 0.83 ** 2 < 1)))
        throw new Error("Invalid dielectric surface parameters");
      spectra.set(bakeSpectrum(material.transmissionSpectrum ?? constantSpectrum(transmission[0]), true), spectrumOffset);
      if (material.thin && !material.transmissionSpectrum && transmission.some(v => v !== transmission[0])) spectralReady = false;
      const worldToTexture = mat4.create();
      const wearBounds = [0, 0, 0, 2];
      const wear = normalizeSurfaceWear(material.surfaceWear);
      let wearPhysical: number[] = Array.from(mat4.create());
      if (hasSurfaceWear(material.surfaceWear)) {
        const objects = description.objects.filter(object => object.material === i);
        if (objects.some(object => object.mesh !== objects[0]!.mesh || object.transform.some((value, axis) => value !== objects[0]!.transform[axis])))
          throw new Error("Textured instances require separate material descriptions");
        if (objects[0]) {
          const mesh = description.meshes[objects[0].mesh]!;
          const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
          for (let vertex = 0; vertex < mesh.positions.length; vertex += 3) for (let axis = 0; axis < 3; axis++) {
            low[axis] = Math.min(low[axis]!, mesh.positions[vertex + axis]!);
            high[axis] = Math.max(high[axis]!, mesh.positions[vertex + axis]!);
          }
          const extent = Math.max(...high.map((value, axis) => value - low[axis]!));
          if (!Number.isFinite(extent) || extent <= 0 || !mat4.invert(worldToTexture, objects[0].transform))
            throw new Error("Invalid surface wear transform or bounds");
          wearPhysical = wearMetric(Array.from(objects[0].transform), extent);
          const normalize = mat4.create();
          mat4.scale(normalize, normalize, [1 / extent, 1 / extent, 1 / extent]);
          mat4.translate(normalize, normalize, low.map((value, axis) => -(value + high[axis]!) * 0.5) as [number, number, number]);
          mat4.multiply(worldToTexture, normalize, worldToTexture);
          for (let axis = 0; axis < 3; axis++) wearBounds[axis] = (high[axis]! - low[axis]!) / (2 * extent);
        }
      }
      makeStructuredView(materialDef, materials, i * materialDef.size).set({
        color: transmission,
        kind: material.thin ? 5 : 2,
        absorption: material.absorption,
        ior: material.ior,
        spectrumOffset,
        absorptionOffset,
        iorModel: material.iorModel === "cauchy" ? 2 : Number(material.iorModel === "nbk7"),
        textureParams: [roughness, ...(material.cauchy ?? [0, 0]), 0],
        worldToTexture,
        wearParams: [...wearEffects.map(name => effectActive(name, wear[name]) ? wear[name].intensity : 0), 1],
        wearEffects: wearEffects.map(name => packWearEffect(name, wear[name])), wearPhysical,
        wearBounds,
      });
      return;
    }
    if (
      !color.every(
        (v) =>
          Number.isFinite(v) &&
          v >= 0 &&
          (material.type !== "diffuse" || v <= 1),
      )
    )
      throw new Error("Invalid material spectrum");
    makeStructuredView(materialDef, materials, i * materialDef.size).set({
      color,
      kind: material.type === "diffuse" ? 0 : 1,
      absorption: [0, 0, 0],
      ior: 1,
      spectrumOffset,
      absorptionOffset,
      iorModel: 0,
    });
  });
  const objects = new Set(description.lights.map((light) => light.object));
  if (objects.size !== description.lights.length)
    throw new Error("Duplicate area light");
  const isEmitter = (type: string | undefined) =>
    type === "emissive" || type === "lava";
  for (const object of objects)
    if (
      !description.objects[object] ||
      !isEmitter(
        description.materials[description.objects[object]!.material]?.type,
      )
    )
      throw new Error("Invalid area light object");
  // Every emitter must participate in both light and BSDF estimates.
  for (const [i, object] of description.objects.entries())
    if (
      object.visible !== false && isEmitter(description.materials[object.material]?.type) &&
      !objects.has(i)
    )
      throw new Error("Emissive object missing from area lights");
  // Sorted IDs support logarithmic PDF lookup for detailed emissive meshes.
  const lightTriangles = bvh.triangles
    .filter((triangle) => objects.has(triangle.surface))
    .sort((a, b) => a.id - b.id);
  const areas = lightTriangles.map((t) => {
    const ab = t.b.map((v, i) => v - t.a[i]!),
      ac = t.c.map((v, i) => v - t.a[i]!);
    return (
      0.5 *
      Math.hypot(
        ab[1]! * ac[2]! - ab[2]! * ac[1]!,
        ab[2]! * ac[0]! - ab[0]! * ac[2]!,
        ab[0]! * ac[1]! - ab[1]! * ac[0]!,
      )
    );
  });
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  const lights = new ArrayBuffer(
    Math.max(1, lightTriangles.length) * lightDef.size,
  );
  let cdf = 0;
  lightTriangles.forEach((triangle, i) => {
    const material = description.materials[triangle.material]!;
    if (material.type !== "emissive" && material.type !== "lava")
      throw new Error("Invalid emitter");
    const emission =
      material.type === "emissive"
        ? material.emission
        : material.secondary.map((v) => v * material.emissionPower);
    const probability = areas[i]! / totalArea;
    cdf += probability;
    makeStructuredView(lightDef, lights, i * lightDef.size).set({
      ...triangle,
      area: areas[i],
      probability,
      emission,
      triangleId: triangle.id,
      cdf: i === lightTriangles.length - 1 ? 1 : cdf,
      spectrumOffset: (3 + 2 * triangle.material) * 471,
    });
  });
  return {
    materials,
    lights,
    lightCount: lightTriangles.length,
    spectra: spectra.buffer,
    spectralReady,
  };
}
