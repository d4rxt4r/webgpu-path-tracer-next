import type { MaterialDescription, SpectrumTable, Vec3 } from "./types";

export interface DielectricSettings {
  mode: "auto" | "volume" | "thin";
  ior: number;
  dispersion: boolean;
  abbe: number;
  transmission: Vec3;
  depth: number;
  roughness: number;
}
export const defaultDielectric: DielectricSettings = {
  mode: "auto", ior: 1.7, dispersion: false, abbe: 64,
  transmission: [Math.exp(-0.7), Math.exp(-0.4), Math.exp(-0.008)],
  depth: 0.1, roughness: 0,
};
export function cauchyCoefficients(ior: number, abbe: number): [number, number] {
  const b = (ior - 1) / (abbe * (1 / 0.48613 ** 2 - 1 / 0.65627 ** 2));
  return [ior - b / 0.5876 ** 2, b];
}
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
export function linearToHex(color: Vec3): string {
  return "#" + color.map(v => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)).toString(16).padStart(2, "0")).join("");
}
export function hexToLinear(hex: string): Vec3 {
  return [1, 3, 5].map(i => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as Vec3;
}
/** Nonnegative artistic reconstruction, interpolating the RGB channel wavelengths. */
export function transmissionSpectrum(color: Vec3): SpectrumTable {
  return [[360, color[2]], [460, color[2]], [550, color[1]], [610, color[0]], [830, color[0]]];
}
export function dielectricMaterial(settings: DielectricSettings, solid: boolean): MaterialDescription {
  if (!["auto", "volume", "thin"].includes(settings.mode) || !Number.isFinite(settings.ior) || settings.ior < 1 || settings.ior > 2.5 ||
      !Number.isFinite(settings.abbe) || settings.abbe < 10 || settings.abbe > 1000 ||
      !Number.isFinite(settings.depth) || settings.depth < 0.0001 || settings.depth > 1000 ||
      !Number.isFinite(settings.roughness) || settings.roughness < 0 || settings.roughness > 1 ||
      !settings.transmission.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
    throw new Error("Invalid dielectric settings");
  if (settings.mode === "volume" && !solid) throw new Error("Объёмный диэлектрик требует замкнутую модель. Включите замыкание или выберите Авто / Тонкий.");
  const thin = settings.mode === "thin" || (settings.mode === "auto" && !solid);
  const absorption = settings.transmission.map(v => -Math.log(Math.max(1e-4, v)) / settings.depth) as Vec3;
  return {
    type: "dielectric", thin, ior: settings.ior,
    iorModel: settings.dispersion ? "cauchy" : "constant",
    cauchy: cauchyCoefficients(settings.ior, settings.abbe),
    roughness: settings.roughness, transmission: settings.transmission,
    transmissionSpectrum: transmissionSpectrum(settings.transmission),
    absorption: thin ? [0, 0, 0] : absorption,
    absorptionSpectrum: transmissionSpectrum(absorption),
  };
}
