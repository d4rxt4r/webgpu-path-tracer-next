/// <reference lib="webworker" />
import { OBJ_MAX_BYTES, parseObj } from "./obj";
import type { ImportedObj, ObjOptions } from "./obj";
import { repairMesh } from "./mesh-repair";
self.onmessage = async (event: MessageEvent<File | { repair: ImportedObj } | { url: string; options?: ObjOptions }>) => {
  try {
    if ("repair" in event.data) {
      const result = repairMesh(event.data.repair);
      self.postMessage({ result }, { transfer: [result.mesh.positions.buffer, result.mesh.indices.buffer, result.mesh.normals!.buffer, ...(result.mesh.shells ? [result.mesh.shells.buffer] : [])] });
      return;
    }
    let text: string;
    if ("url" in event.data) {
      const response = await fetch(event.data.url);
      if (!response.ok) throw new Error(`OBJ: HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > OBJ_MAX_BYTES) throw new Error("Файл OBJ превышает 128 MiB.");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > OBJ_MAX_BYTES) throw new Error("Файл OBJ превышает 128 MiB.");
      text = new TextDecoder().decode(bytes);
    } else {
      if (event.data.size > OBJ_MAX_BYTES) throw new Error("Файл OBJ превышает 128 MiB.");
      text = await event.data.text();
    }
    const result = parseObj(text, "url" in event.data ? event.data.options : undefined);
    self.postMessage({ result }, { transfer: [result.mesh.positions.buffer, result.mesh.indices.buffer, result.mesh.normals!.buffer, ...(result.mesh.shells ? [result.mesh.shells.buffer] : [])] });
  } catch (error) { self.postMessage({ error: (error as Error).message }); }
};
