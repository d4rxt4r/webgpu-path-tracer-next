import { describe, expect, it } from "vitest";
import {
  PacketBudget,
  PacketUniforms,
  TileBudget,
} from "../src/render/compute-packets";

describe("bounded compute packets", () => {
  it("respects a calibrated throughput floor without preventing growth", () => {
    const tiles = new TileBudget(128, 128);
    for (let i = 0; i < 10; i++) tiles.observe(100, 1);
    expect(tiles.size).toBe(128);
    tiles.observe(1, 4);
    expect(tiles.size).toBe(256);
    tiles.observe(100, 1);
    expect(tiles.size).toBe(128);
  });
  it("shrinks expensive tiles and caps inexpensive tiles", () => {
    const tiles = new TileBudget(128);
    tiles.observe(100, 4);
    expect(tiles.size).toBe(64);
    tiles.observe(40, 4);
    expect(tiles.size).toBe(64);
    for (let i = 0; i < 10; i++) tiles.observe(100, 1);
    expect(tiles.size).toBe(16);
    for (let i = 0; i < 10; i++) tiles.observe(1, 4);
    expect(tiles.size).toBe(256);
    tiles.observe(NaN, 1);
    expect(tiles.size).toBe(256);
  });
  it("responds to workload changes without unbounded submissions", () => {
    const budget = new PacketBudget();
    expect(budget.steps("gather", false)).toBe(100);
    expect(budget.steps("pt", true)).toBe(1);
    budget.observe("gather", 100, 40, 50);
    expect(budget.steps("gather", false)).toBe(20);
    budget.observe("pt", 2, undefined, 32);
    expect(budget.steps("pt", false)).toBe(1);
    for (let i = 0; i < 50; i++) budget.observe("gather", 128, 0.1, 3);
    expect(budget.steps("gather", false)).toBe(128);
  });
  it("gives every dispatch a distinct snapshot and guards capacity", () => {
    Object.assign(globalThis, { GPUBufferUsage: { COPY_SRC: 1, COPY_DST: 2 } });
    const writes: number[] = [],
      copies: number[] = [];
    const device = {
      limits: { minUniformBufferOffsetAlignment: 256 },
      createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
      queue: {
        writeBuffer: (_: unknown, offset: number) => writes.push(offset),
      },
    } as unknown as GPUDevice;
    const encoder = {
      copyBufferToBuffer: (_: unknown, offset: number) => copies.push(offset),
    } as unknown as GPUCommandEncoder;
    const uniforms = new PacketUniforms(device);
    uniforms.begin();
    for (let i = 0; i < 256; i++)
      uniforms.write(encoder, {} as GPUBuffer, new ArrayBuffer(144));
    expect(new Set(writes).size).toBe(256);
    expect(copies).toEqual(writes);
    expect(() =>
      uniforms.write(encoder, {} as GPUBuffer, new ArrayBuffer(16)),
    ).toThrow("capacity");
    uniforms.begin();
    uniforms.write(encoder, {} as GPUBuffer, new ArrayBuffer(16));
    expect(writes.at(-1)).toBe(0);
    uniforms.dispose();
  });
});
