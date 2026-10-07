# Medium state: implementation and validation

## Completed checks

- Unit suite: 125/125; TypeScript, production build, and diff checks passed.
- GPU state tests: eight invariants at capacities 2/4/8/32; precise shell tests:
  nine cases; all reported zero errors (`final-state-and-shells.json`).
- RGB/spectral overflow replay: 14 cases, including 32 initial camera media;
  no errors or missing samples, maximum relative RMSE 1.22e-7
  (`accepted-medium-replay.json`).
- Forced dense queue replay and PT pause/resume: complete sample counts, no
  nonfinite values; PT matched exactly, SPPM relative RMSE 7.44e-10
  (`accepted-forced-replay.json`).
- Analytic glass/prism and dense queue checks are recorded separately in
  `analytical-checks.json`; these preceded the final journal storage adjustment.
- All 12 final long comparisons completed with zero transport errors, 128
  samples per pixel, and 2,097,152 emitted photon paths. Maximum relative RMSE:
  raw 0.08891%, floor ROI 0.26092%, filtered 0.01683%. At checkpoints 8/32/128,
  mean luminance and floor mean differed by at most 0.00209%.
  See `accepted-long-summary.json` and paired PFM/PNG artifacts.

Source baseline: `d19b2f9` (the checkout had advanced beyond the reported
`5608436` → `27c7cda` regression before implementation). The saved
`baseline-shaders.json` contains the original assembled modules. Reports contain
SHA-256 hashes of the actual compiled modules and packed scene/material data.
Historical absolute timings of 0.2/0.4 seconds have not been reproduced here.

## Shipped behavior

Medium identity, insertion order, and signed winding are preserved. Preview and
commit operate on a pointer; reflection restores precise coincident transitions
using a small undo journal. The journal is absent from common shader source and
is reused across boundaries in the precise pass.

Both PT and SPPM retain capacity 32 for every scene. Compact SPPM capacities
2/4/8 and overflow replay are implemented as internal benchmark options, but
are not enabled by default: none improved both Control and Rastagotchi in the
selection experiment. There is no classifier based on total scene shell count.
Rastagotchi uses the same pointer operations as Control.

Final capacity selection, GPU median milliseconds for 8 iterations after warmup
and five alternating measured rounds (`final-capacity-*-report.json`):

| Capacity | Control | Rastagotchi |
| --- | ---: | ---: |
| 32 | 1338.31 | 2710.37 |
| 2 | 2448.23 | 2417.62 |
| 4 | 2624.98 | 3281.72 |
| 8 | 2603.29 | 6609.50 |

All final selection runs reported zero errors. Capacity 2 gains on Rastagotchi
but loses substantially on Control; no compact candidate gains on both. These
are comparisons between the final implementation's capacities, not between the
two originally reported commits. Completion times, phase timestamps, retries,
memory, compilation times, scene hashes and module hashes are in the reports.

## Measurement boundaries

The selection runs used Intel gen-12lp, 960×720, spectral SPPM, depth 8, seed 17,
8 iterations, 16,384 photon paths per iteration and per batch, radius 0.03.
Source and sampler must match across variants. One variant's point/photon buffers
is resident at a time; submission size follows the production packet budget.
GPU timestamps cover compute submissions; completion time includes CPU encoding
and diagnostic readback, and excludes compilation, image export and filtering.
Reported buffer/texture memory excludes driver code and private scratch memory.

Some original common-kernel runs reported intersection error code 3 before BVH
traversal (seed 17, iteration 0, pixel 539945, depth 1). It also reproduced with
ordinary queue writes and without timestamps. The original precise kernel
completed the control probe without errors. Failed runs cannot establish a
performance improvement, and warmup retries did not reliably make the original
Control kernel valid. Do not use rejected experiments as an acceptance claim.

`adaptive-*-report.json` records the earlier selection experiment, including
failed original Control runs, before the final journal storage adjustment.
`final-capacity-*-report.json` records the final four-capacity comparison.
`accepted-long-*-report.json` compares the final common/replay
kernel against the original **always-precise** module for numerical validation;
its reference timing is not the previous application's common-kernel timing.

Long validation uses 320×240, RGB and spectral modes, 128 iterations, seeds
1/17/29, both scenes, and checkpoints at 8/32/128 iterations. Raw PFM retains
signed linear RGB. PNG uses exposure 1, Reinhard, then sRGB transfer. Filtering
uses the production denoiser with 3 passes, strength 1, and glass filtering.
The fixed floor ROI is x=[25%,75%), y=[70%,95%).

## Reproduction

Start Vite on port 5360 and `node scripts/media-artifacts.mjs` on port 5361.
Use the connected browser on `/assets/SUZANNE-NOTICES.txt` to avoid a competing
application render. Import `benchmarkMedia` from `/src/debug/benchmark-media.ts`
and `saveMediaBenchmark` from `/src/debug/save-media-benchmark.ts`.
Retain `navigator.gpu` and reuse one `createDevice()` result for a long matrix
through the debug `gpu` option; the caller destroys that device afterward.
On this browser/adapter, a longer matrix sometimes failed compilation with
`A valid external Instance reference no longer exists.` Retaining the API/device
did not prevent it. Reload the quiet page between groups of three cases; failed
or interrupted cases must be rerun, rather than counted as completed validation.

The browser helpers `verifyMediumState`, `verifyMediumReplay`, `verifyShells`,
`verifyTransportQueue` and `verifyTransportReplay` exercise winding/order,
reflection rollback, compact overflow, 32 initial camera media, and dense queue
overflow without losing or duplicating paths.

The long comparison is reproducible from the quiet page with these options:

```js
window.mediaGpuApi = navigator.gpu;
const { benchmarkMedia } = await import('/src/debug/benchmark-media.ts');
const { saveMediaBenchmark } = await import('/src/debug/save-media-benchmark.ts');
const { createDevice } = await import('/src/gpu/device.ts');
const { cornellScene } = await import('/src/scene/cornell.ts');
const { presentationScene } = await import('/src/scene/presentation.ts');
const { loadBuiltinObj } = await import('/src/assets/builtin-obj.ts');
const { specializedSppmShader } = await import('/src/transport/sppm-shader.ts');
const { fastTransportShader } = await import('/src/transport/fast-source.ts');
const baseline = await (await fetch('/docs/validation/medium-performance/baseline-shaders.json')).json();
const variants = [
  { name: 'reference-precise', capacity: 32, source: {
    precise: baseline.specializedSppmShader, common: baseline.specializedSppmShader,
  } },
  { name: 'pointer32', capacity: 32, source: {
    precise: specializedSppmShader, common: fastTransportShader(specializedSppmShader),
  } },
];
const gpu = await createDevice();
const scenes = {
  control: cornellScene('blue-glass'),
  rastagotchi: await presentationScene('blue-glass', await loadBuiltinObj('rastagotchi')),
};
try {
  // Repeat for RGB/spectral, seeds 1/17/29, both scenes; reload between batches.
  const sceneName = 'control', mode = 'spectral', seed = 1;
  const report = await benchmarkMedia(scenes[sceneName], variants, {
    gpu, mode, seed, width: 320, height: 240, iterations: 128, repeats: 1,
    warmupIterations: 8, validWarmups: 1, checkpoints: [8, 32, 128],
    denoise: { enabled: true, passes: 3, strength: 1, filterGlass: true },
  });
  await saveMediaBenchmark(`accepted-long-${sceneName}-${mode}-${seed}`,
    report, variants, ['reference-precise', 'pointer32']);
} finally {
  gpu.device.destroy();
}
```
