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
