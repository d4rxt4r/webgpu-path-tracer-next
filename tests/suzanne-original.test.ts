import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseObj } from "../src/assets/obj";
import { repairMesh } from "../src/assets/mesh-repair";
import { meshTopology } from "../src/assets/mesh-topology";

it("ships the native Blender primitive and closes its independent shells at runtime", () => {
  const text = readFileSync(new URL("../assets/suzanne-original.obj", import.meta.url), "utf8");
  expect(text.split("\n").filter(line => line.startsWith("v "))).toHaveLength(507);
  expect(text.split("\n").filter(line => line.startsWith("f "))).toHaveLength(968);
  const original = parseObj(text), before = structuredClone(original);
  expect(original.triangles).toBe(968);
  expect(original.shells).toBe(3);
  expect(original.solid).toBe(false);
  const closed = repairMesh(original);
  expect(closed.repair.success, closed.repair.reason).toBe(true);
  expect(closed.repair.closedHoles).toBe(4);
  expect(closed.triangles).toBe(1002);
  expect(closed.shells).toBe(3);
  expect(meshTopology(closed.mesh).solid).toBe(true);
  expect(original).toEqual(before);
});
