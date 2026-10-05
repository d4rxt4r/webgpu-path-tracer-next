import type { CameraDescription, Vec3 } from "../scene/types";

const controls = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".inspector input[id], .inspector select[id]")]
  .filter(control => !control.id.endsWith("-value") && control.type !== "file");

export function createSettingsLink(root: ParentNode, address: string, camera: CameraDescription): string {
  const fields = controls(root);
  if (fields.find(field => field.id === "scene")?.value === "uploaded")
    throw new Error("Для ссылки выберите предустановленный объект: локальный OBJ не передаётся через URL.");
  const url = new URL(address);
  url.search = "";
  url.hash = "";
  url.searchParams.set("settings", "1");
  for (const field of fields) url.searchParams.set(field.id,
    field.type === "checkbox" ? (field as HTMLInputElement).checked ? "1" : "0" : field.value);
  for (const key of ["position", "target", "up"] as const) url.searchParams.set(`camera-${key}`, camera[key].join(","));
  return url.href;
}

/** Restore only existing settings controls, within the same limits as the UI. */
export function restoreSettingsLink(root: ParentNode, query: URLSearchParams, initial: CameraDescription): CameraDescription | undefined {
  if (query.get("settings") !== "1") return;
  const fields = controls(root);
  for (const field of fields) {
    const raw = query.get(field.id);
    if (raw === null) continue;
    if (field.tagName === "SELECT") {
      if ([...(field as HTMLSelectElement).options].some(option => option.value === raw)) field.value = raw;
    } else if (field.type === "checkbox") {
      if (raw === "0" || raw === "1") (field as HTMLInputElement).checked = raw === "1";
    } else if (field.type === "color") {
      if (/^#[0-9a-f]{6}$/i.test(raw)) field.value = raw;
    } else if (field.type === "number" || field.type === "range") {
      const input = field as HTMLInputElement, value = Number(raw);
      if (raw.trim() && Number.isFinite(value) && (!input.min || value >= Number(input.min)) && (!input.max || value <= Number(input.max))
        && (input.step !== "1" || Number.isInteger(value))) input.value = raw;
    }
  }
  const read = (id: string) => Number(fields.find(field => field.id === id)!.value);
  const camera = structuredClone(initial);
  camera.verticalFov = read("fov");
  const distance = read("camera-distance"), delta = initial.position.map((v, i) => v - initial.target[i]!);
  camera.position = initial.target.map((v, i) => v + delta[i]! * distance / Math.hypot(...delta)) as Vec3;
  const vectors = ["position", "target", "up"].map(key => {
    const raw = query.get(`camera-${key}`)?.split(",");
    return raw?.length === 3 && raw.every(value => value.trim() && Number.isFinite(Number(value))) ? raw.map(Number) as Vec3 : undefined;
  });
  const [position, target, up] = vectors;
  if (position && target && up) {
    const d = position.map((v, i) => v - target[i]!), length = Math.hypot(...d), upLength = Math.hypot(...up);
    const cross = Math.hypot(d[1]! * up[2] - d[2]! * up[1], d[2]! * up[0] - d[0]! * up[2], d[0]! * up[1] - d[1]! * up[0]);
    if (length >= 0.25 - 1e-9 && length <= 12 + 1e-9 && Number.isFinite(length) && Math.abs(upLength - 1) < 1e-6
      && [...position, ...target].every(value => Math.abs(value) <= 1e6) && cross > length * upLength * 1e-6)
      Object.assign(camera, { position, target, up });
  }
  return camera;
}
