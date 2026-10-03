import { expect, it } from "vitest";
import { encodePfm } from "../src/app/export";
import { applySceneControls } from "../src/scene/editor";
import type { SceneControls } from "../src/scene/editor";
import { cornellScene } from "../src/scene/cornell";
import { bakeTriangles } from "../src/accel/geometry";

it("exports signed RGB in bottom-up little-endian PFM order", () => {
  const bytes = encodePfm({
    width: 1,
    height: 2,
    linearRgb: new Float32Array([1, 2, 3, -1, 5, 6]),
  });
  const header = new TextEncoder().encode("PF\n1 2\n-1.0\n");
  expect(bytes.slice(0, header.length)).toEqual(header);
  const view = new DataView(bytes.buffer);
  expect(view.getFloat32(header.length, true)).toBe(-1);
  expect(view.getFloat32(header.length + 12, true)).toBe(1);
  expect(() =>
    encodePfm({
      width: 1,
      height: 1,
      linearRgb: new Float32Array([NaN, 0, 0]),
    }),
  ).toThrow();
});

it("keeps edited glass inside the room and scales RGB and spectral materials together", () => {
  const scene = cornellScene("glass");
  const controls: SceneControls = {
    "object-scale": 1.4,
    "object-x": 0.35,
    "object-y": 0.5,
    "object-z": 0.35,
    "object-rotation": 45,
    "light-power": 24,
    "light-size": 1.2,
    "light-x": 0.2,
    "light-z": 0.1,
    "wall-neutral": 0.9,
    "wall-red": 1.2,
    "wall-green": 0.8,
    ior: 1.7,
    absorption: 2,
    albedo: 0.3,
  };
  applySceneControls(scene, controls);
  const object = bakeTriangles(scene).filter((t) => t.surface === 6);
  for (const triangle of object)
    for (const point of [triangle.a, triangle.b, triangle.c]) {
      expect(point[0]).toBeGreaterThan(-1);
      expect(point[0]).toBeLessThan(1);
      expect(point[1]).toBeGreaterThan(0);
      expect(point[1]).toBeLessThan(2);
      expect(point[2]).toBeGreaterThan(-1);
      expect(point[2]).toBeLessThan(1);
    }
  expect(controls["object-y"]).toBeGreaterThan(0.5);
  expect(scene.materials[3]).toMatchObject({ emission: [24, 24, 24] });
  expect(scene.materials[4]).toMatchObject({
    ior: 1.7,
    absorption: [0.3, 0.06, 0.02],
  });
  expect(scene.materials[1]).toMatchObject({ reflectance: [0.78, 0.06, 0.06] });
});
