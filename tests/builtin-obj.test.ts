import { beforeEach, expect, it, vi } from "vitest";

const { loadUrl, repair } = vi.hoisted(() => ({ loadUrl: vi.fn(), repair: vi.fn() }));
vi.mock("../src/assets/obj-import", () => ({ ObjImporter: class {
  loadUrl = loadUrl;
  repair = repair;
} }));
const original = { mesh: { positions: new Float32Array([0,0,0]), indices: new Uint32Array() }, solid: false, triangles: 4 };
const closed = { ...original, solid: true, triangles: 6, repair: { success: true, closedHoles: 1 } };
beforeEach(() => {
  vi.resetModules(); loadUrl.mockReset().mockResolvedValue(original); repair.mockReset().mockResolvedValue(closed);
});
it("registers exactly four OBJ models and caches source and repaired versions independently", async () => {
  const { builtinModels, loadBuiltinObj } = await import("../src/assets/builtin-obj");
  expect(Object.keys(builtinModels)).toEqual(["suzanne-high-poly", "suzanne", "buddha", "rastagotchi"]);
  for (const id of Object.keys(builtinModels) as (keyof typeof builtinModels)[]) {
    expect(builtinModels[id].source.endsWith(".obj")).toBe(true);
    expect(await loadBuiltinObj(id, false)).toBe(original);
    expect(await loadBuiltinObj(id)).toBe(closed);
    expect(await loadBuiltinObj(id, false)).toBe(original);
    expect(await loadBuiltinObj(id)).toBe(closed);
  }
  expect(loadUrl).toHaveBeenCalledTimes(4); expect(repair).toHaveBeenCalledTimes(4);
  expect(loadUrl).toHaveBeenCalledWith(builtinModels.buddha.url, { maxDimension: 1.7, skipDegenerateTriangles: true });
});
it("retries a failed source load instead of retaining a rejected cache entry", async () => {
  const { loadBuiltinObj } = await import("../src/assets/builtin-obj");
  loadUrl.mockRejectedValueOnce(new Error("HTTP 404"));
  await expect(loadBuiltinObj("buddha")).rejects.toThrow("HTTP 404");
  expect(await loadBuiltinObj("buddha")).toBe(closed);
  expect(loadUrl).toHaveBeenCalledTimes(2);
});
