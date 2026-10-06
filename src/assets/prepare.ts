import type { PackedScene } from '../accel/pack';
import type { SceneDescription } from '../scene/types';
import type { PackedTransport } from '../accel/materials';
export type PreparedScene = PackedScene & PackedTransport;

/** Superseding a build terminates its Worker and rejects the obsolete request. */
export class ScenePreparer {
  private worker?: Worker;
  private revision = 0;
  private reject?: (reason: Error) => void;
  private idleTimer?: ReturnType<typeof setTimeout>;
  prepare(scene: SceneDescription): Promise<PreparedScene> {
    this.cancel();
    clearTimeout(this.idleTimer);
    const revision = ++this.revision;
    const worker = this.worker ?? new Worker(new URL('../accel/prepare.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      const finish = (): void => {
        if (this.worker !== worker) return;
        this.reject = undefined;
        clearTimeout(this.idleTimer);
        // Reuse during edits, then release the worker's large transient geometry heap.
        this.idleTimer = setTimeout(() => { if (this.worker === worker && !this.reject) { worker.terminate(); this.worker = undefined; } }, 5000);
      };
      worker.onmessage = (event: MessageEvent<{ revision: number; packed?: PreparedScene; error?: string }>) => {
        if (event.data.revision !== revision || revision !== this.revision) return;
        finish();
        if (event.data.error || !event.data.packed) { worker.terminate(); this.worker = undefined; reject(new Error(event.data.error ?? 'Invalid Worker result')); }
        else resolve(event.data.packed);
      };
      worker.onerror = event => { event.preventDefault(); if (this.worker !== worker || revision !== this.revision) return; finish(); clearTimeout(this.idleTimer); worker.terminate(); this.worker = undefined; reject(new Error(event.message || 'Scene Worker failed')); };
      worker.postMessage({ revision, scene });
    });
  }
  cancel(): void { this.revision++; if (this.reject) { this.worker?.terminate(); this.worker = undefined; } this.reject?.(new DOMException('Scene build superseded', 'AbortError')); this.reject = undefined; }
  dispose(): void { clearTimeout(this.idleTimer); this.cancel(); this.worker?.terminate(); this.worker = undefined; }
}
