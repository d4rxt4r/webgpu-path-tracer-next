import { describe, expect, it } from "vitest";
import { makeStructuredView } from "webgpu-utils";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { definitions, packBvh } from "../src/accel/pack";
import { cornellScene } from "../src/scene/cornell";
import { bruteForce, traverseBvh } from "../src/accel/intersect";
import { fixedRays } from "../src/debug/intersection-fixture";

describe("cached scene preparation", () => {
  it("packs the identical byte layout as independent WGSL reflection", () => {
    const bvh = buildBvh(bakeTriangles(cornellScene())),
      packed = packBvh(bvh);
    const nodes = new ArrayBuffer(packed.nodes.byteLength),
      triangles = new ArrayBuffer(packed.triangles.byteLength);
    bvh.nodes.forEach((node, i) =>
      makeStructuredView(
        definitions.structs.BvhNode!,
        nodes,
        i * definitions.structs.BvhNode!.size,
      ).set(node),
    );
    bvh.triangles.forEach((triangle, i) =>
      makeStructuredView(
        definitions.structs.Triangle!,
        triangles,
        i * definitions.structs.Triangle!.size,
      ).set({...triangle,padding1:new Uint32Array(packed.triangles)[i*24+19],padding2:new Uint32Array(packed.triangles)[i*24+23]}),
    );
    expect(new Uint8Array(packed.nodes)).toEqual(new Uint8Array(nodes));
    expect(new Uint8Array(packed.triangles)).toEqual(new Uint8Array(triangles));
  });
  it("escape links skip exactly the rejected subtree", () => {
    for (const leaf of [1, 2, 4, 8, 16]) {
      const bvh = buildBvh(bakeTriangles(cornellScene()), 48, leaf);
      const words = new Uint32Array(packBvh(bvh).triangles);
      const escape = (index: number) => words[Math.floor(index / 2) * 24 + (index % 2 ? 23 : 19)]!;
      // Reference traversal uses recursion and never reads the packed links.
      for (let rejected = -1; rejected < bvh.nodes.length; rejected++) {
        const expected: number[] = [];
        const visit = (index: number) => {
          expected.push(index);
          const node = bvh.nodes[index]!;
          if (index !== rejected && node.count === 0) {
            visit(node.first); visit(node.first + 1);
          }
        };
        visit(0);
        const actual: number[] = [];
        let index = 0;
        while (index !== 0xffffffff && actual.length <= bvh.nodes.length) {
          actual.push(index);
          const node = bvh.nodes[index]!;
          index = index === rejected || node.count > 0 ? escape(index) : node.first;
        }
        expect(index).toBe(0xffffffff);
        expect(actual).toEqual(expected);
      }
    }
  });
  it("retains closest and any hits for experimental leaf sizes", () => {
    const triangles = bakeTriangles(cornellScene()),
      rays = fixedRays(128);
    for (const leaf of [1, 2, 4, 8, 16]) {
      const bvh = buildBvh(triangles, 48, leaf);
      for (const ray of rays) {
        expect(traverseBvh(ray, bvh)?.id).toBe(bruteForce(ray, triangles)?.id);
        expect(Boolean(traverseBvh(ray, bvh, true))).toBe(
          Boolean(bruteForce(ray, triangles)),
        );
      }
    }
  });
});
