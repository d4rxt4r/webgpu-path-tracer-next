import { ObjImporter } from "./obj-import";
import type { ImportedObj } from "./obj";
import type { RepairedObj, RepairReport } from "./mesh-repair";
import highPolyUrl from "../../assets/Suzanne.obj?url";

export type OriginalSuzanne = ImportedObj & { repair?: RepairReport };
interface Cache { original?: Promise<ImportedObj>; repaired?: Promise<RepairedObj> }
const originalCache: Cache = {}, highPolyCache: Cache = {};

/** Native Blender render triangles; normalization and optional repair happen at runtime. */
export function loadOriginalSuzanne(close = true): Promise<OriginalSuzanne> {
  return loadSuzanne(originalCache, `${import.meta.env.BASE_URL}assets/suzanne-original.obj`, "suzanne-original.obj", close);
}
export function loadHighPolySuzanne(close = true): Promise<OriginalSuzanne> {
  return loadSuzanne(highPolyCache, highPolyUrl, "Suzanne.obj", close);
}
function loadSuzanne(cache: Cache, url: string, filename: string, close: boolean): Promise<OriginalSuzanne> {
  cache.original ??= (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Suzanne OBJ: HTTP ${response.status}`);
    return new ObjImporter().load(new File([await response.blob()], filename));
  })().catch(error => { cache.original = undefined; throw error; });
  if (!close) return cache.original;
  cache.repaired ??= cache.original.then(model => new ObjImporter().repair(model)).catch(error => { cache.repaired = undefined; throw error; });
  return cache.repaired;
}
