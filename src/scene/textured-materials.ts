import type { SpectrumTable, TexturedMaterial, Vec3 } from "./types";
import {
  constantSpectrum,
  integrateXyz,
  xyzToLinearRgb,
} from "../transport/spectrum";

// Explicit thermal spectrum, not an RGB color silently reinterpreted as a spectrum.
export function lavaEmission(
  temperature = 2000,
): Pick<TexturedMaterial, "secondary" | "secondarySpectrum"> {
  if (!Number.isFinite(temperature) || temperature < 1400 || temperature > 3600)
    throw new Error("Invalid lava temperature");
  const thermal: SpectrumTable = Array.from({ length: 95 }, (_, i) => {
    const nm = 360 + i * 5,
      meters = nm * 1e-9;
    return [
      nm,
      1 / (meters ** 5 * Math.expm1(0.01438776877 / (meters * temperature))),
    ];
  });
  const thermalRgb = xyzToLinearRgb(integrateXyz(thermal));
  const thermalPeak = Math.max(...thermalRgb);
  const emissionSpectrum: SpectrumTable = thermal.map(([nm, value]) => [
    nm,
    value / thermalPeak,
  ]);
  const emissionRgb = thermalRgb.map((value) =>
    Math.max(0, value / thermalPeak),
  ) as Vec3;
  return { secondary: emissionRgb, secondarySpectrum: emissionSpectrum };
}

export function texturedMaterial(type: "marble" | "lava"): TexturedMaterial {
  return type === "marble"
    ? {
        type,
        reflectance: [0.025, 0.043, 0.033],
        spectrum: [
          [360, 0.012],
          [450, 0.018],
          [530, 0.043],
          [580, 0.032],
          [650, 0.025],
          [830, 0.025],
        ],
        secondary: [0.8, 0.8, 0.8],
        secondarySpectrum: constantSpectrum(0.8),
        scale: 9,
        turbulence: 2,
        width: 0.1,
        coating: 0.08,
        emissionPower: 0,
      }
    : {
        type,
        reflectance: [0.025, 0.025, 0.025],
        spectrum: constantSpectrum(0.025),
        ...lavaEmission(),
        scale: 6,
        turbulence: 2,
        width: 0.04,
        coating: 0.08,
        emissionPower: 6,
      };
}
