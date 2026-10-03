import type { PackedScene } from '../accel/pack';
import type { SceneDescription } from '../scene/types';

/** Superseding a build terminates its Worker and rejects the obsolete request. */
export class ScenePreparer {
  private worker?: Worker;
  private revision = 0;
  private reject?: (reason: Error) => void;
  prepare(scene: SceneDescription): Promise<PackedScene> {
    this.cancel();
    const revision = ++this.revision;
    const worker = new Worker(new URL('../accel/prepare.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      const finish = (): void => { worker.terminate(); if (this.worker === worker) { this.worker = undefined; this.reject = undefined; } };
      worker.onmessage = (event: MessageEvent<{ revision: number; packed?: PackedScene; error?: string }>) => {
        if (event.data.revision !== revision || revision !== this.revision) return;
        finish();
        if (event.data.error || !event.data.packed) reject(new Error(event.data.error ?? 'Invalid Worker result'));
        else resolve(event.data.packed);
      };
      worker.onerror = event => { event.preventDefault(); finish(); reject(new Error(event.message || 'Scene Worker failed')); };
      worker.postMessage({ revision, scene });
    });
  }
  cancel(): void { this.revision++; this.worker?.terminate(); this.worker = undefined; this.reject?.(new DOMException('Scene build superseded', 'AbortError')); this.reject = undefined; }
  dispose(): void { this.cancel(); }
}
