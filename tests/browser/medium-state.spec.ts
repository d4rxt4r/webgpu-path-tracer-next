import { expect, test } from "@playwright/test";

test("medium transactions preserve winding and order at compact and full capacity", async ({page}) => {
  await page.goto("/assets/SUZANNE-NOTICES.txt");
  for (const capacity of [2,4,8,32] as const) {
    const result = await page.evaluate(async capacity => {
      const url = "/src/debug/verify-medium-state.ts";
      const {verifyMediumState} = await import(/* @vite-ignore */ url);
      return verifyMediumState(capacity);
    }, capacity);
    for (const entry of result.results) expect(entry.errors, `${capacity}: ${entry.name}`).toBe(0);
  }
});

test("compact SPPM replays photon overflow and up to 32 initial camera media", async ({page}) => {
  // Fresh adapters may compile each distinct capacity for tens of seconds.
  test.setTimeout(1800000);
  await page.goto("/assets/SUZANNE-NOTICES.txt");
  const results = await page.evaluate(async () => {
    const url = "/src/debug/verify-medium-replay.ts";
    const {verifyMediumReplay} = await import(/* @vite-ignore */ url);
    return verifyMediumReplay();
  });
  for (const entry of results) {
    expect(entry.errors, JSON.stringify(entry)).toBe(0);
    expect(entry.countsComplete).toBe(true);
    expect(entry.emittedPhotons).toBe(4096);
    expect(entry.nonFinite).toBe(0);
    expect(entry.energy).toBeGreaterThan(0);
    expect(entry.normalizedRmse).toBeLessThan(0.005);
  }
});
