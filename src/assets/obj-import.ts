import { OBJ_MAX_BYTES } from "./obj";
import type { ImportedObj, ObjOptions } from "./obj";
import type { RepairedObj } from "./mesh-repair";

export class ObjImporter {
  private worker?: Worker;
  private reject?: (error: Error) => void;
  cancel(): void {
    this.worker?.terminate(); this.worker = undefined;
    this.reject?.(new DOMException("Импорт отменён", "AbortError")); this.reject = undefined;
  }
  load(file: File): Promise<ImportedObj> {
    this.cancel();
    if (file.size > OBJ_MAX_BYTES) return Promise.reject(new Error("Файл OBJ превышает 128 MiB."));
    if (!/\.obj$/i.test(file.name)) return Promise.reject(new Error("Выберите файл .obj."));
    return this.run<ImportedObj>(file);
  }
  /** Built-in assets stay in the worker and avoid disk-backed Blob/File clones. */
  loadUrl(url: string, options: ObjOptions = {}): Promise<ImportedObj> {
    this.cancel();
    return this.run<ImportedObj>({ url: new URL(url, location.href).href, options });
  }
  repair(source: ImportedObj): Promise<RepairedObj> {
    this.cancel();
    return this.run<RepairedObj>({ repair: source });
  }
  private run<T extends ImportedObj>(message: File | { repair: ImportedObj } | { url: string; options: ObjOptions }): Promise<T> {
    const worker = new Worker(new URL("./obj.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      const finish = () => { worker.terminate(); if (this.worker === worker) { this.worker = undefined; this.reject = undefined; } };
      worker.onmessage = (event: MessageEvent<{ result?: T; error?: string }>) => {
        finish();
        if (event.data.result) resolve(event.data.result); else reject(new Error(event.data.error || "Ошибка импорта OBJ."));
      };
      worker.onerror = event => { event.preventDefault(); finish(); reject(new Error(event.message || "Ошибка Worker импорта.")); };
      // Clone the mesh; its original buffers stay available for reverting repair.
      worker.postMessage(message);
    });
  }
}
