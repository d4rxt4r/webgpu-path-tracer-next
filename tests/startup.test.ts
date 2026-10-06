import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ device: {} as any, sppm: vi.fn(), denoiser: vi.fn() }));
vi.mock("../src/gpu/device", () => ({
  createDevice: async () => ({device: mocks.device, name: "test GPU", adapter: {info: {vendor: "test"}}}),
  checkedShader: async (_device: unknown, _source: string, label: string) => ({label}),
}));
vi.mock("../src/assets/sobol", () => ({loadSobol: async () => new ArrayBuffer(65536)}));
vi.mock("../src/render/sppm-integrator", () => ({SPPM_POINT_BYTES: 128, SppmIntegrator: {create: mocks.sppm}}));
vi.mock("../src/render/denoiser", () => ({Denoiser: {create: mocks.denoiser}}));
import { IntersectionRenderer } from "../src/render/intersection-renderer";

let renderer: IntersectionRenderer;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", {gpu: {getPreferredCanvasFormat: () => "bgra8unorm"}});
  vi.stubGlobal('document', {hidden: true});
  vi.stubGlobal("GPUBufferUsage", {UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8, MAP_READ: 16, INDIRECT: 32});
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  mocks.device = {
    features: new Set(), limits: {minUniformBufferOffsetAlignment: 256},
    lost: new Promise(() => {}), addEventListener: vi.fn(), destroy: vi.fn(),
    pushErrorScope: vi.fn(), popErrorScope: async () => null,
    createComputePipelineAsync: vi.fn(async () => ({})),
    createRenderPipelineAsync: vi.fn(async () => ({})),
    createBuffer: ({size}: {size: number}) => ({size, destroy: vi.fn(), unmap() {}, getMappedRange: () => new ArrayBuffer(size)}),
  };
  const canvas = {getContext: () => ({configure() {}, unconfigure() {}})} as unknown as HTMLCanvasElement;
  renderer = new IntersectionRenderer(canvas, () => {}, () => {});
});
afterEach(() => {renderer.dispose(); vi.unstubAllGlobals();});

test("GPU preparation can precede the scene and retains precise PT without compiling optional modes", async () => {
  const preparation = renderer.prepareGpu();
  expect(renderer.prepareGpu()).toBe(preparation);
  await preparation;
  expect(mocks.device.createComputePipelineAsync.mock.calls.map(([descriptor]: [GPUComputePipelineDescriptor]) => descriptor.compute.entryPoint)).toEqual(["main", "repairMain"]);
  expect(mocks.device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
  expect(mocks.sppm).not.toHaveBeenCalled();
  expect(mocks.denoiser).not.toHaveBeenCalled();
  await renderer.prepareIntegrator("pt");
  expect(mocks.device.createComputePipelineAsync).toHaveBeenCalledTimes(2);
});

test("concurrent and repeated Quality requests share preparation on the device", async () => {
  const integrator = {dispose: vi.fn()};
  mocks.sppm.mockResolvedValue(integrator);
  await Promise.all([renderer.prepareIntegrator("sppm"), renderer.prepareIntegrator("sppm")]);
  await renderer.prepareIntegrator("sppm");
  expect(mocks.sppm).toHaveBeenCalledTimes(1);
  renderer.dispose();
  expect(integrator.dispose).toHaveBeenCalledTimes(1);
});

test("an integrator completing after disposal releases resources instead of attaching to the renderer", async () => {
  await renderer.prepareGpu();
  let finish!: (value: unknown) => void;
  mocks.sppm.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const pending = renderer.prepareIntegrator("sppm");
  await vi.waitFor(() => expect(mocks.sppm).toHaveBeenCalledTimes(1));
  renderer.dispose();
  const integrator = {dispose: vi.fn()};
  finish(integrator);
  await pending;
  expect(integrator.dispose).toHaveBeenCalledTimes(1);
});

test("failed Quality preparation leaves the prepared PT usable and does not repeatedly compile", async () => {
  await renderer.prepareGpu();
  mocks.sppm.mockRejectedValue(new Error("Quality compilation failed"));
  await expect(renderer.prepareIntegrator("sppm")).rejects.toThrow("Quality compilation failed");
  await expect(renderer.prepareIntegrator("sppm")).rejects.toThrow("Quality compilation failed");
  await renderer.prepareIntegrator("pt");
  expect(mocks.sppm).toHaveBeenCalledTimes(1);
  expect(mocks.device.createComputePipelineAsync).toHaveBeenCalledTimes(2);
});

test("validating a deferred settings edit is synchronous and does not commit it", () => {
  expect(renderer.validateSettings({maxDepth: 4}).maxDepth).toBe(4);
  expect(renderer.validateSettings({}).maxDepth).toBe(8);
  expect(() => renderer.validateSettings({maxDepth: 0})).toThrow("Invalid path tracing settings");
  expect(mocks.sppm).not.toHaveBeenCalled();
});

test('PT mode requests reuse at most the RGB and generic variants', async () => {
  await renderer.prepareGpu();
  const state = renderer as any, generic = state.pathPipeline;
  state.specializedPtSource = true;
  await Promise.all([renderer.prepareIntegrator('pt', 'rgb'), renderer.prepareIntegrator('pt', 'rgb')]);
  const rgb = state.pathPipeline;
  expect(rgb).not.toBe(generic);
  expect(mocks.device.createComputePipelineAsync).toHaveBeenCalledTimes(4);
  renderer.setSettings({mode: 'spectral'});
  await renderer.prepareIntegrator('pt', 'spectral');
  expect(state.pathPipeline).toBe(generic);
  renderer.setSettings({mode: 'rgb'});
  await renderer.prepareIntegrator('pt', 'rgb');
  expect(state.pathPipeline).toBe(rgb);
  expect(state.pathVariants.size).toBe(2);
  expect(mocks.device.createComputePipelineAsync).toHaveBeenCalledTimes(4);
});

test('a pending RGB variant cannot replace the newly requested spectral pipeline', async () => {
  await renderer.prepareGpu();
  const state = renderer as any, generic = state.pathPipeline;
  state.specializedPtSource = true;
  const finish: ((pipeline: unknown) => void)[] = [];
  mocks.device.createComputePipelineAsync.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
  const pending = renderer.prepareIntegrator('pt', 'rgb');
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  renderer.setSettings({mode: 'spectral'});
  await renderer.prepareIntegrator('pt', 'spectral');
  finish.forEach(resolve => resolve({})); await pending;
  expect(state.pathPipeline).toBe(generic);
  renderer.setSettings({mode: 'rgb'}); await renderer.prepareIntegrator('pt', 'rgb');
  expect(state.pathPipeline).not.toBe(generic);
});

test('pipeline rejection from a disposed device cannot revive its variants', async () => {
  await renderer.prepareGpu();
  const state = renderer as any; state.specializedPtSource = true;
  const fail: ((reason: Error) => void)[] = [];
  mocks.device.createComputePipelineAsync.mockImplementation(() => new Promise((_resolve, reject) => fail.push(reject)));
  const pending = renderer.prepareIntegrator('pt', 'rgb');
  await vi.waitFor(() => expect(fail).toHaveLength(2));
  renderer.dispose(); fail.forEach(reject => reject(new Error('Instance dropped')));
  await expect(pending).resolves.toBeUndefined();
  expect(state.pathVariants.size).toBe(0);
});
