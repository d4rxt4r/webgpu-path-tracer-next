import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OBJ_MAX_BYTES } from "../src/assets/obj";

const worker = { onmessage: undefined as unknown as (event: { data: { url: string; options?: { maxDimension?: number } } }) => Promise<void>, postMessage: vi.fn() };
const fetchAsset = vi.fn();
beforeAll(async () => {
  vi.stubGlobal("self", worker);
  vi.stubGlobal("fetch", fetchAsset);
  await import("../src/assets/obj.worker");
});
beforeEach(() => { worker.postMessage.mockClear(); fetchAsset.mockReset(); });
afterAll(() => vi.unstubAllGlobals());

it("loads built-in geometry directly from network bytes in the worker", async () => {
  const text = readFileSync(new URL("fixtures/solid.obj", import.meta.url), "utf8");
  fetchAsset.mockResolvedValue(new Response(text));
  await worker.onmessage({ data: { url: "http://localhost/assets/model.obj" } });
  expect(fetchAsset).toHaveBeenCalledWith("http://localhost/assets/model.obj");
  expect(worker.postMessage.mock.calls[0]![0].result).toMatchObject({ solid: true, triangles: 4 });
});
it("reports failed HTTP responses without trying to parse their body", async () => {
  fetchAsset.mockResolvedValue(new Response("missing", { status: 404 }));
  await worker.onmessage({ data: { url: "http://localhost/missing.obj" } });
  expect(worker.postMessage).toHaveBeenCalledWith({ error: "OBJ: HTTP 404" });
});
it("passes built-in normalization options through the worker", async () => {
  fetchAsset.mockResolvedValue(new Response(readFileSync(new URL("fixtures/solid.obj", import.meta.url), "utf8")));
  await worker.onmessage({ data: { url: "http://localhost/model.obj", options: { maxDimension: 1.7 } } });
  const positions: Float32Array = worker.postMessage.mock.calls[0]![0].result.mesh.positions;
  expect(Math.max(...positions) - Math.min(...positions)).toBeCloseTo(1.7, 6);
});
it("rejects oversized advertised assets before downloading their body", async () => {
  const read = vi.fn();
  fetchAsset.mockResolvedValue({ ok: true, headers: new Headers({ "content-length": String(OBJ_MAX_BYTES + 1) }), arrayBuffer: read });
  await worker.onmessage({ data: { url: "http://localhost/large.obj" } });
  expect(read).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenCalledWith({ error: "Файл OBJ превышает 128 MiB." });
});
it("checks actual bytes when the server omits the content length", async () => {
  fetchAsset.mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => ({ byteLength: OBJ_MAX_BYTES + 1 }) });
  await worker.onmessage({ data: { url: "http://localhost/large.obj" } });
  expect(worker.postMessage).toHaveBeenCalledWith({ error: "Файл OBJ превышает 128 MiB." });
});
