import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseObj } from "../src/assets/obj";

it("preserves high poly Suzanne source polygons and normalizes only at runtime", () => {
  const text = readFileSync(new URL("../assets/Suzanne.obj", import.meta.url), "utf8");
  const model = parseObj(text);
  expect(model.triangles).toBe(251904);
  expect(model.mesh.positions.every(Number.isFinite)).toBe(true);
  expect(model.mesh.normals!.every(Number.isFinite)).toBe(true);
}, 30000);
