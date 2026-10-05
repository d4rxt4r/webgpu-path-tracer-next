import { describe, expect, it } from "vitest";
import { profiles, qualityProfile } from "../src/app/profiles";
import { checkPhotonLimits, photonAllocation, settingsLimits } from "../src/render/settings-limits";
import { renderEditor } from "../src/app/editor-ui";
import { settingHelp } from "../src/app/settings-help";

describe("expanded settings", () => {
  it("offers every preset in the editor and describes each setting", () => {
    const html = renderEditor(false);
    for (const id of Object.keys(profiles)) expect(html).toContain(`value="${id}"`);
    const ids = [...html.matchAll(/<(?:input|select) id="([^"]+)"/g)].map(match => match[1]!);
    for (const id of ids.filter(id => !id.endsWith("-value") && id !== "obj-file")) expect(settingHelp[id], id).toBeTruthy();
    expect(html).not.toMatch(/<p class="hint">/);
    expect(html).toContain(`max="${settingsLimits.maxMemoryMiB}"`);
    expect(html).toContain(`max="${settingsLimits.maxPhotons}"`);
  });

  it("keeps integrated defaults and gives larger quality modes adequate budgets", () => {
    expect(profiles.quality.maxPixels).toBe(307200);
    expect(profiles.quality.photonBatchSize).toBe(1024);
    expect(profiles["quality-4k"]).toMatchObject({ maxPixels: 8294400, memoryBudgetMiB: 4096, photonsPerIteration: 262144 });
    expect(qualityProfile("quality-qhd")).toBe(true);
    expect(qualityProfile("reference-4k")).toBe(false);
  });

  it("rejects oversized buffers and dispatches independently before allocation", () => {
    const allocation = photonAllocation(16384, 64);
    expect(allocation.photons).toBe(16384 * 65 * 64);
    const limits = { maxBufferSize: 128 * 1048576, maxStorageBufferBindingSize: 128 * 1048576, maxComputeWorkgroupsPerDimension: 65535 };
    expect(() => checkPhotonLimits(16384, 64, limits)).not.toThrow();
    expect(() => checkPhotonLimits(16384, 64, { ...limits, maxStorageBufferBindingSize: 64 * 1048576 })).toThrow(/GPU/);
    expect(() => checkPhotonLimits(16384, 64, { ...limits, maxComputeWorkgroupsPerDimension: 1024 })).toThrow(/GPU/);
  });
});
