import { expect, it } from "vitest";
import { COMPUTE_READBACK_BYTES, transportDiagnostic, transportFailure } from "../src/render/transport-diagnostics";

it("retains the first GPU failure after unmapping, without interpreting timestamps as diagnostics", () => {
  const buffer = new ArrayBuffer(COMPUTE_READBACK_BYTES);
  const words = new Uint32Array(buffer);
  words.set([1,1,2,1,9,683613,1,25621,25800,1,1316,740]);
  new BigUint64Array(buffer,64).set([1000n,2000n]);
  const record = transportDiagnostic(buffer);
  words.fill(0);
  expect(transportFailure(record)).toBe("GPU transport failed for 1 operations: medium; phase=camera, iteration=9, pixel=683613, depth=1, triangle=25621, medium=25800, seed=1, size=1316x740.");
});

it("identifies photons and represents absent triangles without unsigned sentinel noise", () => {
  const words = Uint32Array.from([2,1,1,2,12,42,3,0xffffffff,0xffffffff,17,640,480]);
  expect(transportFailure(words)).toContain("phase=photon, iteration=12, photon=42, depth=3, triangle=none, medium=none");
});
