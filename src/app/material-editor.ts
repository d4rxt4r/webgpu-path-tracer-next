import type { SphereMaterial } from "../scene/cornell";
import type { SceneDescription, SurfaceWearV2 } from "../scene/types";
import { defaultDielectric, dielectricMaterial, hexToLinear, linearToHex, type DielectricSettings } from "../scene/dielectric-settings";
import { textureControlIds, type TextureControls } from "../scene/editor";
import { nbk7Ior } from "../transport/spectrum";
import { wearControlIds, wearEffects, wearCommonFields, wearDetailFields, defaultWearEffect } from "../scene/surface-wear";

export const materialControlIds = ["dielectric-mode", "dispersion", "abbe", "transmission-color", "transmission-depth", "roughness", "texture-kind", ...wearControlIds];
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
export function baseMaterial(): SphereMaterial {
  const type = field("material").value;
  return type === "textured" ? field("texture-kind").value as "marble" | "lava" : type === "diffuse" ? "diffuse" : "blue-glass";
}
export function readDielectric(): DielectricSettings {
  const color = field("transmission-color").value;
  return {
    mode: field("dielectric-mode").value as DielectricSettings["mode"],
    ior: Number(field("ior").value), dispersion: field("dispersion").checked,
    abbe: Number(field("abbe").value), roughness: Number(field("roughness").value),
    depth: Number(field("transmission-depth").value),
    surfaceWear: { version: 2, ...Object.fromEntries(wearEffects.map(name => [name, {
      ...defaultWearEffect(name), enabled: field(`wear-${name}-enabled`).checked,
      space: field(`wear-${name}-space`).value, scale: Number(field(`wear-${name}-scale`).value),
      ...Object.fromEntries([...wearCommonFields, ...wearDetailFields[name]].map(f => [f.key, Number(field(`wear-${name}-${f.key}`).value)])),
    }])) } as SurfaceWearV2,
    transmission: color === linearToHex(defaultDielectric.transmission) ? [...defaultDielectric.transmission] : hexToLinear(color),
  };
}
export function applyMaterialEditor(scene: SceneDescription, solid: boolean): void {
  if (field("material").value === "dielectric") scene.materials[4] = dielectricMaterial(readDielectric(), solid);
}
export function materialMetadata(solid: boolean) {
  if (field("material").value === "dielectric") {
    const settings = readDielectric(), material = dielectricMaterial(settings, solid);
    if (material.type !== "dielectric") throw new Error("Unexpected dielectric material");
    return { ...settings, actualMode: material.thin ? "thin" : "volume", iorModel: material.iorModel,
      cauchy: settings.dispersion ? material.cauchy : undefined, absorption: material.absorption,
      absorptionSpectrum: material.absorptionSpectrum, transmissionSpectrum: material.transmissionSpectrum };
  }
  if (field("material").value === "textured") return { actualMode: undefined, texture: field("texture-kind").value, ...Object.fromEntries(textureControlIds.map(id => [id, Number(field(id).value)])) };
  return { actualMode: undefined, albedo: Number(field("albedo").value) };
}
export function syncMaterialEditor(solid: boolean, ready = true): void {
  const type = field("material").value, texture = field("texture-kind").value;
  for (const [id, visible] of [["dielectric-settings", type === "dielectric"], ["diffuse-settings", type === "diffuse"], ["texture-group", type === "textured"], ["dispersion-settings", field("dispersion").checked], ["lava-settings", texture === "lava"]] as const)
    document.getElementById(id)!.hidden = !visible;
  const thin = field("dielectric-mode").value === "thin" || (field("dielectric-mode").value === "auto" && !solid);
  (field("dielectric-mode") as unknown as HTMLSelectElement).querySelector<HTMLOptionElement>('[value="volume"]')!.disabled = !solid;
  for (const id of ["ior", "abbe", "roughness", "transmission-depth", "dispersion", "transmission-color", "dielectric-mode", "albedo", "texture-kind", ...textureControlIds, ...wearControlIds]) {
    const disabled = id === "albedo" ? type !== "diffuse" : id === "texture-kind" || (textureControlIds as readonly string[]).includes(id) ? type !== "textured" || (id.startsWith("lava-") && texture !== "lava") : type !== "dielectric" || (id === "abbe" && !field("dispersion").checked) || (id === "transmission-depth" && thin);
    field(id).disabled = !ready || disabled;
    const number = document.getElementById(`${id}-value`) as HTMLInputElement | null;
    if (number) number.disabled = !ready || disabled;
  }
  for (const name of wearEffects) {
    const id = `wear-${name}`, enabled = field(`${id}-enabled`).checked;
    document.getElementById(`${id}-settings`)!.hidden = !enabled;
    const scale = field(`${id}-scale`), physical = field(`${id}-space`).value === "scene";
    scale.min = physical ? "0.00001" : "0.05"; scale.max = physical ? "1000" : "20";
    const slider = document.querySelector<HTMLInputElement>(`[data-log-for="${id}-scale"]`)!;
    slider.value = String(1000 * Math.log(Number(scale.value)/Number(scale.min)) / Math.log(Number(scale.max)/Number(scale.min)));
    slider.setAttribute("aria-valuetext", scale.value);
    for (const control of document.getElementById(`${id}-settings`)!.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, select, button"))
      control.disabled = !ready || type !== "dielectric" || !enabled;
  }
}
export function initializeMaterialEditor(material: SphereMaterial): void {
  field("material").value = material === "diffuse" ? "diffuse" : material === "marble" || material === "lava" ? "textured" : "dielectric";
  field("texture-kind").value = material === "lava" ? "lava" : "marble";
  field("transmission-color").value = linearToHex(defaultDielectric.transmission);
  if (material === "glass" || material.startsWith("nbk7")) {
    field("ior").value = String(material === "glass" ? 1.5 : nbk7Ior(587.6));
    field("transmission-color").value = "#ffffff";
    field("dispersion").checked = material === "nbk7";
  }
  syncMaterialEditor(true, false);
}
export function textureMemory() {
  const read = () => Object.fromEntries(textureControlIds.map(id => [id, Number(field(id).value)])) as TextureControls;
  let current = field("texture-kind").value;
  const marble = read();
  let states: Record<string, TextureControls> = { marble: { ...marble, "texture-scale": 9, "texture-width": 0.1 }, lava: { ...marble, "texture-scale": 6, "texture-width": 0.04 } };
  return {
    switch: () => {
      states[current] = read(); current = field("texture-kind").value;
      for (const [id, value] of Object.entries(states[current]!)) field(id).value = String(value);
    },
    capture: () => { states[current] = read(); return structuredClone({ current, states }); },
    restore: (snapshot: { current: string; states: Record<string, TextureControls> }) => { current = snapshot.current; states = structuredClone(snapshot.states); },
  };
}
