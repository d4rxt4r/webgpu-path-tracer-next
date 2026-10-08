interface Variant { job: Promise<unknown>; ready: boolean }
const devices = new WeakMap<GPUDevice, Map<string, Map<number, Variant>>>();

/** Cache pipelines only, never render targets or integrator storage. */
export async function pipelineVariant<T>(device: GPUDevice, family: string, mask: number, compile: () => Promise<T>): Promise<T> {
  let families = devices.get(device);
  if (!families) devices.set(device, families = new Map());
  let variants = families.get(family);
  if (!variants) families.set(family, variants = new Map());
  let entry = variants.get(mask);
  if (entry) { variants.delete(mask); variants.set(mask, entry); }
  else {
    entry = { job: compile(), ready: false }; variants.set(mask, entry);
    const current = entry;
    // In-flight work remains deduplicated until it completes.
    entry.job.then(() => {
      current.ready = true;
      const ready = [...variants!].filter(([, value]) => value.ready);
      for (const [key] of ready.slice(0, Math.max(0, ready.length - 2))) variants!.delete(key);
    }, () => { if (variants!.get(mask) === current) variants!.delete(mask); });
  }
  return entry.job as Promise<T>;
}
