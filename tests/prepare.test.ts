import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScenePreparer } from '../src/assets/prepare';
import { cornellScene } from '../src/scene/cornell';

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: {revision: number}[] = [];
  onmessage?: (event: any) => void;
  onerror?: (event: any) => void;
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: {revision: number}): void { this.messages.push(message); }
  respond(): void { this.onmessage?.({data: {revision: this.messages.at(-1)!.revision, packed: {triangleCount: 12}}}); }
}
let preparer: ScenePreparer;
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); preparer = new ScenePreparer(); });
afterEach(() => { preparer.dispose(); vi.unstubAllGlobals(); });

it('reuses the idle worker and releases it on disposal', async () => {
  const first = preparer.prepare(cornellScene()), worker = FakeWorker.instances[0]!;
  worker.respond(); await first;
  const second = preparer.prepare(cornellScene()); worker.respond(); await second;
  expect(FakeWorker.instances).toHaveLength(1);
  expect(worker.terminate).not.toHaveBeenCalled();
  preparer.dispose(); expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it('terminates a superseded build and ignores its late response', async () => {
  const first = preparer.prepare(cornellScene()), old = FakeWorker.instances[0]!;
  const rejection = expect(first).rejects.toThrow('superseded');
  const second = preparer.prepare(cornellScene()), current = FakeWorker.instances[1]!;
  await rejection; old.respond();
  old.onerror?.({ preventDefault() {}, message: 'late worker error' });
  expect(old.terminate).toHaveBeenCalledTimes(1);
  current.respond(); expect((await second).triangleCount).toBe(12);
});
it('releases an idle worker after the reuse window', async () => {
  vi.useFakeTimers();
  try {
    const pending = preparer.prepare(cornellScene()), worker = FakeWorker.instances[0]!;
    worker.respond(); await pending;
    vi.advanceTimersByTime(5000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const next = preparer.prepare(cornellScene());
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1]!.respond(); await next;
  } finally { vi.useRealTimers(); }
});
