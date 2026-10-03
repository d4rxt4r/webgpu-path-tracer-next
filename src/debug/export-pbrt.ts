import { bakeTriangles } from "../accel/geometry";
import type {
  MaterialDescription,
  SceneDescription,
  SpectrumTable,
} from "../scene/types";
import {
  constantSpectrum,
  nbk7Ior,
  integrateXyz,
  CIE_Y_INTEGRAL,
} from "../transport/spectrum";

/** Same world triangles, normals, spectra and camera as the engine; no RGB upsampling. */
export function exportPbrt(
  scene: SceneDescription,
  width: number,
  height: number,
  samples: number,
  filename: string,
  maxDepth = 32,
): string {
  const spectrum = (name: string, table: SpectrumTable) =>
    `"spectrum ${name}" [${table.flat().join(" ")}]`;
  const camera = scene.camera;
  const lines = [
    "# Generated spectral reference scene. PBRT v4, CIE1931 sensor, linear sRGB, no white balance.",
    "Scale -1 1 1",
    `LookAt ${camera.position.join(" ")} ${camera.target.join(" ")} ${camera.up.join(" ")}`,
    `Camera "perspective" "float fov" [${camera.verticalFov}]`,
    `Film "rgb" "integer xresolution" [${width}] "integer yresolution" [${height}] "string filename" ["${filename}"] "string sensor" ["cie1931"] "float iso" [${100 / CIE_Y_INTEGRAL}] "float whitebalance" [0]`,
    'PixelFilter "box" "float xradius" [0.5] "float yradius" [0.5]',
    `Sampler "sobol" "integer pixelsamples" [${samples}]`,
    `Integrator "volpath" "integer maxdepth" [${maxDepth}]`,
    "WorldBegin",
  ];
  const hasAbsorption = (material: MaterialDescription) =>
    material.type === "dielectric" &&
    (material.absorptionSpectrum
      ? material.absorptionSpectrum.some(([, value]) => value > 0)
      : material.absorption.some((value) => value > 0));
  for (const material of scene.materials) {
    if (material.type === "marble" || material.type === "lava")
      throw new Error(
        "PBRT reference export does not support procedural marble/lava materials",
      );
    const rgb =
      material.type === "diffuse"
        ? material.reflectance
        : material.type === "emissive"
          ? material.emission
          : material.absorption;
    const table =
      material.type === "dielectric"
        ? material.absorptionSpectrum
        : material.spectrum;
    if (!table && (rgb[0] !== rgb[1] || rgb[0] !== rgb[2]))
      throw new Error(
        "PBRT spectral export requires explicit spectra for non-neutral RGB",
      );
  }
  for (const [index, material] of scene.materials.entries())
    if (material.type === "dielectric" && hasAbsorption(material)) {
      const absorption =
        material.absorptionSpectrum ?? constantSpectrum(material.absorption[0]);
      lines.push(
        `MakeNamedMedium "glass-${index}" "string type" ["homogeneous"] ${spectrum("sigma_a", absorption)} ${spectrum("sigma_s", constantSpectrum(0))}`,
      );
    }
  const triangles = bakeTriangles(scene);
  for (const [surface, object] of scene.objects.entries()) {
    const material = scene.materials[object.material]!;
    if (material.type === "marble" || material.type === "lava")
      throw new Error(
        "PBRT reference export does not support procedural marble/lava materials",
      );
    lines.push("AttributeBegin");
    if (material.type === "diffuse")
      lines.push(
        `Material "diffuse" ${spectrum("reflectance", material.spectrum ?? constantSpectrum(material.reflectance[0]))}`,
      );
    else if (material.type === "emissive") {
      const emission =
        material.spectrum ?? constantSpectrum(material.emission[0]);
      // Undo PBRT's one-nit light normalization to retain the original radiance.
      // Film ISO above separately converts its CIE integral to our normalized XYZ.
      lines.push(
        `AreaLightSource "diffuse" ${spectrum("L", emission)} "float scale" [${Math.fround(CIE_Y_INTEGRAL * integrateXyz(emission)[1])}]`,
        `Material "diffuse" ${spectrum("reflectance", constantSpectrum(0))}`,
      );
    } else {
      const eta =
        material.iorModel === "nbk7"
          ? Array.from(
              { length: 471 },
              (_, i) => [360 + i, nbk7Ior(360 + i)] as [number, number],
            )
          : constantSpectrum(material.ior);
      lines.push(
        `Material "dielectric" ${spectrum("eta", eta)} "float uroughness" [0] "float vroughness" [0]`,
      );
      if (hasAbsorption(material))
        lines.push(`MediumInterface "glass-${object.material}" ""`);
    }
    const faces = triangles.filter((triangle) => triangle.surface === surface);
    const positions = faces.flatMap((triangle) => [
      ...triangle.a,
      ...triangle.b,
      ...triangle.c,
    ]);
    const normals = faces.flatMap((triangle) => [
      ...triangle.na,
      ...triangle.nb,
      ...triangle.nc,
    ]);
    lines.push(
      `Shape "trianglemesh" "point3 P" [${positions.join(" ")}] "normal N" [${normals.join(" ")}] "integer indices" [${Array.from({ length: faces.length * 3 }, (_, i) => i).join(" ")}]`,
      "AttributeEnd",
    );
  }
  return lines.join("\n") + "\n";
}
