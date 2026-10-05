import { decodeHdr } from './hdr';
self.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; quality: number }>) => {
  try { const image = decodeHdr(event.data.buffer, event.data.quality); self.postMessage({ image }, { transfer: [image.pixels.buffer] }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
