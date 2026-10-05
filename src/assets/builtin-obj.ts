import { ObjImporter } from "./obj-import";
import type { ImportedObj } from "./obj";
import type { RepairedObj, RepairReport } from "./mesh-repair";
import highPolyUrl from "../../assets/Suzanne.obj?url";
import suzanneUrl from "../../assets/suzanne-original.obj?url";
import buddhaUrl from "../../assets/Buddha.obj?url";
import rastagotchiUrl from "../../assets/Rastagotchi.obj?url";

export const builtinModels = {
  "suzanne-high-poly": { url: highPolyUrl, source: "assets/Suzanne.obj", maxDimension: 1.2 },
  suzanne: { url: suzanneUrl, source: "assets/suzanne-original.obj", maxDimension: 1.2 },
  buddha: { url: buddhaUrl, source: "assets/Buddha.obj", maxDimension: 1.7 },
  rastagotchi: { url: rastagotchiUrl, source: "assets/Rastagotchi.obj", maxDimension: 1.2 },
} as const;
export type BuiltinModelId = keyof typeof builtinModels;
export type BuiltinObj = ImportedObj & { repair?: RepairReport };
export function isBuiltinModel(id: string): id is BuiltinModelId {
  return Object.hasOwn(builtinModels, id);
}
interface Cache { original?: Promise<ImportedObj>; repaired?: Promise<RepairedObj> }
const caches = new Map<BuiltinModelId, Cache>();

/** All presets use the same worker importer and keep source and repaired meshes separate. */
export function loadBuiltinObj(id: BuiltinModelId, close = true): Promise<BuiltinObj> {
  let cache = caches.get(id);
  if (!cache) { cache = {}; caches.set(id, cache); }
  const asset = builtinModels[id];
  cache.original ??= new ObjImporter().loadUrl(asset.url, { maxDimension: asset.maxDimension, skipDegenerateTriangles: id === "buddha" })
    .catch(error => { cache.original = undefined; throw error; });
  if (!close) return cache.original;
  cache.repaired ??= cache.original.then(model => new ObjImporter().repair(model))
    .catch(error => { cache.repaired = undefined; throw error; });
  return cache.repaired;
}
