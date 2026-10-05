import { HDR_MAX_BYTES, type HdrImage } from './hdr';
export const hdrPresets = {
  studio_small_09: new URL('../../assets/hdr/studio_small_09.hdr', import.meta.url).href,
  kiara_1_dawn: new URL('../../assets/hdr/kiara_1_dawn.hdr', import.meta.url).href,
  venice_sunset: new URL('../../assets/hdr/venice_sunset.hdr', import.meta.url).href,
};
export class HdrImporter {
  private worker?: Worker;
  private cancel?: () => void;
  private controller?: AbortController;
  async load(source: string | File, quality: number): Promise<HdrImage> {
    this.dispose(); const controller = this.controller = new AbortController();
    let buffer: ArrayBuffer;
    if (source instanceof File) {
      if (!/\.hdr$/i.test(source.name) || source.size > HDR_MAX_BYTES) throw new Error('Нужен .hdr размером до 128 MiB.');
      buffer = await source.arrayBuffer();
    } else {
      const response = await fetch(source, { signal: controller.signal });
      if (!response.ok) throw new Error('Не удалось загрузить HDR.');
      buffer = await response.arrayBuffer();
    }
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return new Promise((resolve, reject) => {
      const worker = this.worker = new Worker(new URL('./hdr-worker.ts', import.meta.url), { type: 'module' });
      this.cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
      const finish = () => { worker.terminate(); if (this.worker === worker) { this.worker = undefined; this.cancel = undefined; } };
      worker.onmessage = event => { finish(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.image); };
      worker.onerror = () => { finish(); reject(new Error('Ошибка декодирования HDR.')); };
      worker.postMessage({ buffer, quality }, [buffer]);
    });
  }
  dispose(): void { this.controller?.abort(); this.worker?.terminate(); this.cancel?.(); this.worker = undefined; this.cancel = undefined; }
}
