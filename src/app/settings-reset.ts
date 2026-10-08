import { readControl, writeControl } from "./numeric-controls";
import { nbk7Ior } from "../transport/spectrum";

/** Defaults are independent of the last selected render preset. */
export function numericDefault(id: string, controlScene: boolean): number {
  const selected = (name: string) => (document.getElementById(name) as HTMLSelectElement).value;
  const material = selected("material");
  if (selected("scene") === "rastagotchi" && material === "dielectric") {
    if (id === "ior") return 1.5;
    if (id === "roughness") return 0.03;
    if (["wear-scratches", "wear-scuffs", "wear-fingerprints"].includes(id)) return 0.5;
  }
  if (id === "ior") return material === "dielectric" ? 1.7 : material === "blue-glass" ? 1.7 : material === "glass" ? 1.5 : nbk7Ior(587.6);
  if (id === "object-y") return selected("scene") === "buddha" ? 0.86 : selected("scene") === "control" ? 0.65 : 1;
  const texture = document.getElementById("texture-kind") as HTMLSelectElement | null;
  if (id === "texture-scale") return (texture?.value ?? material) === "lava" ? 6 : 9;
  if (id === "texture-width") return (texture?.value ?? material) === "lava" ? 0.04 : 0.1;
  if (id === "max-depth") return controlScene ? 8 : 32;
  const defaults: Record<string, number> = { seed: 1, "sample-limit": 0, photons: 16384 };
  if (id in defaults) return defaults[id]!;
  const field = document.getElementById(id) as HTMLInputElement;
  return Number(field.dataset.default);
}

export function attachMiddleReset(controlScene: boolean): void {
  for (const field of document.querySelectorAll<HTMLInputElement>('input[type="number"], input[type="range"]')) {
    field.addEventListener("mousedown", event => {
      if (event.button === 1) event.preventDefault();
    });
    field.addEventListener("auxclick", event => {
      if (event.button !== 1) return;
      event.preventDefault();
      if (field.disabled) return;
      const id = (field.dataset.logFor ?? field.id).replace(/-value$/, "");
      const primary = document.getElementById(id) as HTMLInputElement;
      const initial = numericDefault(id, controlScene);
      if (!Number.isFinite(initial) || Number(readControl(document, id)) === initial) return;
      writeControl(document, id, String(initial));
      primary.dispatchEvent(new Event(primary.type === "range" ? "input" : "change", { bubbles: true }));
      if (!field.dataset.logFor) field.value = primary.value;
    });
  }
}
