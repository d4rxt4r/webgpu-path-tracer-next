import { IntersectionRenderer } from "../render/intersection-renderer";
import type { RenderStats } from "../render/intersection-renderer";
import { buddhaScene } from "../scene/buddha";
import type { SphereMaterial } from "../scene/cornell";

/** Exercise the live packet scheduler, memory budget and completed accumulation. */
export async function verifyBuddhaSppm(options: {
  iterations?: number; seed?: number; material?: SphereMaterial;
  width?: number; height?: number; memoryBudgetMiB?: number;
}, progress?: (stats: RenderStats) => void) {
  const iterations = options.iterations ?? 128, seed = options.seed ?? 1;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${options.width ?? 1920}px;height:${options.height ?? 1080}px;visibility:hidden`;
  document.body.append(canvas);
  let renderer: IntersectionRenderer | undefined;
  let stopping = false;
  let resolve!: () => void, reject!: (error: Error) => void;
  const completed = new Promise<void>((yes, no) => {resolve = yes; reject = no;});
  // Install the rejection handler before initialization can report an error.
  void completed.catch(() => {});
  const timeout = setTimeout(() => reject(new Error("Buddha SPPM validation timed out")), 1800000);
  const started = performance.now();
  try {
    renderer = new IntersectionRenderer(canvas, stats => {
      progress?.({...stats});
      if (stats.samples >= iterations && !stopping) {
        stopping = true;
        renderer!.pause();
        resolve();
      }
    }, reject);
    renderer.pause();
    renderer.setDebugView("beauty");
    renderer.setSettings({integrator:"sppm",mode:"rgb",maxDepth:32,seed,
      maxPixels:(options.width ?? 1920)*(options.height ?? 1080),
      memoryBudgetMiB:options.memoryBudgetMiB ?? 192,
      photonsPerIteration:16384,photonBatchSize:1024,initialRadius:0.03});
    await renderer.setScene(await buddhaScene(options.material ?? "glass"));
    await renderer.initialize();
    renderer.resume();
    await completed;
    const capture = await renderer.capture();
    let minCount = Infinity, maxCount = 0;
    for (const count of capture.sampleCounts) {minCount = Math.min(minCount,count);maxCount = Math.max(maxCount,count);}
    let nonFinite = 0, mean = 0;
    for (const value of capture.linearRgb) {if (!Number.isFinite(value)) nonFinite++;mean += value;}
    return {width:capture.width,height:capture.height,iterations:capture.samples,
      emittedPhotons:capture.emittedPhotons,minCount,maxCount,nonFinite,
      mean:mean/capture.linearRgb.length,seed,material:options.material ?? "glass",
      memoryBudgetMiB:options.memoryBudgetMiB ?? 192,elapsedMs:performance.now()-started};
  } finally {
    clearTimeout(timeout);
    renderer?.dispose();
    canvas.remove();
  }
}
