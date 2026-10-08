import { expect, test, vi } from 'vitest';
import { pipelineVariant } from '../src/render/pipeline-variants';

test('wear variants deduplicate compilation and retain the two most recently used masks', async () => {
  const device = {} as GPUDevice, compile = vi.fn(async () => ({}));
  const first = await pipelineVariant(device, 'pt', 0, compile);
  expect(await pipelineVariant(device, 'pt', 0, compile)).toBe(first);
  await pipelineVariant(device, 'pt', 1, compile);
  await pipelineVariant(device, 'pt', 0, compile);
  await pipelineVariant(device, 'pt', 2, compile);
  expect(await pipelineVariant(device, 'pt', 0, compile)).toBe(first);
  await pipelineVariant(device, 'pt', 1, compile);
  expect(compile).toHaveBeenCalledTimes(4);
});

test('pending variants remain shared and failed variants can be retried', async () => {
  const device = {} as GPUDevice;
  let resolve!: (value: object) => void;
  const compile = vi.fn(() => new Promise<object>(done => { resolve = done; }));
  const a = pipelineVariant(device, 'pt', 1, compile);
  await pipelineVariant(device, 'pt', 0, async () => ({}));
  await pipelineVariant(device, 'pt', 2, async () => ({}));
  const b = pipelineVariant(device, 'pt', 1, compile);
  expect(compile).toHaveBeenCalledTimes(1);
  const value = {}; resolve(value);
  expect(await a).toBe(value); expect(await b).toBe(value);
  await expect(pipelineVariant(device, 'guides', 0, async () => { throw Error('failed'); })).rejects.toThrow('failed');
  expect(await pipelineVariant(device, 'guides', 0, async () => value)).toBe(value);
});
