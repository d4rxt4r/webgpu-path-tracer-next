import { expect, test } from "vitest";
import { resolveDenoise } from "../src/render/denoiser";

const base = { enabled: true, passes: 3, strength: 2, filterGlass: false };

test("legacy glass settings and explicit glass mode resolve consistently", () => {
  expect(resolveDenoise(base).glassMode).toBe("off");
  expect(resolveDenoise({ ...base, filterGlass: true }).glassMode).toBe("surface");
  expect(resolveDenoise({ ...base, filterGlass: true, glassMode: "image" }).glassMode).toBe("image");
  expect(resolveDenoise({ ...base, algorithm: "nlm" }).radius).toBe(3);
  expect(resolveDenoise(base).radius).toBe(2);
});

test("reject invalid denoise settings before GPU encoding", () => {
  for (const invalid of [{ radius: 1.5 }, { radius: 6 }, { blend: -1 }, { split: NaN },
    { normalPower: 129 }, { depthScale: 0 }, { glassStrength: Infinity }, { passes: 0 }]) {
    expect(() => resolveDenoise({ ...base, ...invalid })).toThrow("Invalid denoiser");
  }
});
