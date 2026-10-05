/// <reference lib="webworker" />
import { OBJ_MAX_BYTES, parseObj } from "./obj";
import type { ImportedObj } from "./obj";
import { repairMesh } from "./mesh-repair";
self.onmessage = async (event: MessageEvent<File | { repair: ImportedObj }>) => {
  try {
    if ("repair" in event.data) {
      const result = repairMesh(event.data.repair);
      self.postMessage({ result }, { transfer: [result.mesh.positions.buffer, result.mesh.indices.buffer, result.mesh.normals!.buffer, ...(result.mesh.shells ? [result.mesh.shells.buffer] : [])] });
      return;
    }
    if (event.data.size > OBJ_MAX_BYTES) throw new Error("Файл OBJ превышает 128 MiB.");
    const result = parseObj(await event.data.text());
    self.postMessage({ result }, { transfer: [result.mesh.positions.buffer, result.mesh.indices.buffer, result.mesh.normals!.buffer, ...(result.mesh.shells ? [result.mesh.shells.buffer] : [])] });
  } catch (error) { self.postMessage({ error: (error as Error).message }); }
};
