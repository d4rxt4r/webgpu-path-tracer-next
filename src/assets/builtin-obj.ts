import { ObjImporter } from "./obj-import";
import type { ImportedObj } from "./obj";
import type { RepairedObj, RepairReport } from "./mesh-repair";
import manifest from './model-manifest.json';
import { decodeMesh } from './mesh-binary';
import { readCached, writeCached } from './persistent-cache';
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

async function preparedModel(id: BuiltinModelId, closed: boolean): Promise<BuiltinObj> {
  const asset = manifest[id][closed ? 'closed' : 'original'];
  const valid = async (bytes: ArrayBuffer): Promise<BuiltinObj> => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.sha256) throw new Error('Mesh checksum mismatch');
    return decodeMesh(bytes);
  };
  const cached = await readCached(asset.sha256);
  if (cached) { try { return await valid(cached); } catch { /* Fetch replaces corrupt entry. */ } }
  const response = await fetch(`${import.meta.env.BASE_URL}models/${asset.file}`);
  if (!response.ok) throw new Error(`Mesh: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer(), model = await valid(bytes);
  void writeCached(asset.sha256, bytes);
  return model;
}

/** Prepared meshes contain exactly the worker importer's output; OBJ remains the fallback. */
export function loadBuiltinObj(id: BuiltinModelId, close = true): Promise<BuiltinObj> {
  let cache = caches.get(id);
  if (!cache) { cache = {}; caches.set(id, cache); }
  const asset = builtinModels[id];
  const original = (): Promise<ImportedObj> => new ObjImporter().loadUrl(asset.url, { maxDimension: asset.maxDimension, skipDegenerateTriangles: id === "buddha" });
  if (!close) return cache.original ??= preparedModel(id, false).catch(original)
    .catch(error => { cache.original = undefined; throw error; });
  cache.repaired ??= preparedModel(id, true).then(model => model as RepairedObj).catch(async () => {
    cache.original ??= original().catch(error => { cache.original = undefined; throw error; });
    return new ObjImporter().repair(await cache.original);
  })
    .catch(error => { cache.repaired = undefined; throw error; });
  return cache.repaired;
}
