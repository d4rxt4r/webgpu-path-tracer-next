# Performance validation — 2026-10-06

Baseline: Git commit `6a0c8be`. Adapter: Intel `gen-12lp`, existing connected Chrome, one renderer at a time. Development server: Vite on `127.0.0.1:5173`. These are local measurements, not guarantees for other adapters, production hosting or cleared driver caches.

## Changes retained

- Generate lossless binary versions of all four built-in models, both original and repaired, before development/build. Exact Float32 positions/normals, Uint32 indices/shells and repair metadata match the existing browser OBJ importer and repair implementation. Source OBJ import remains the fallback and still handles local files.
- Optional IndexedDB cache is bounded to 192 MiB. Content checksums reject damaged model/scene records; implementation fingerprints invalidate stale geometry and transport records. Camera and environment edits do not invalidate geometry. Material value edits reuse geometry and rebuild transport without rebuilding SAH.
- Scene preparation publishes transferable buffers while optional persistence finishes. The worker is retained for successive edits, then terminated after five idle seconds; cancellation terminates pending work and rejects obsolete requests.
- GPU scene/environment ownership avoids duplicate geometry upload and destruction of buffers still referenced by startup work. Keep the existing RGB preview, prepare the requested mode asynchronously, and commit only the latest requested mode.
- Intel gen-12lp RGB PT uses a smaller kernel with shared dielectric BSDF call sites and constant RGB wavelength mode. Spectral PT and other adapters retain the generic source. Both normal and precision-repair pipelines are prepared before rendering. At most two pipeline pairs are retained.

No reduction in requested resolution, geometry, normals, wear detail, depth, samples or photons was introduced. The existing memory-budget fitting behavior remains. No quantization, approximate transport or denoiser substitution was adopted.

## Startup measurements

A CPU-only, serial five-pair Rastagotchi comparison measured OBJ import plus repair against binary loading plus checksum. All arrays and repair reports were bitwise identical.

| Operation | Original median / max, ms | Binary median / max, ms |
| --- | ---: | ---: |
| Model import and repair / binary decode and checksum | 3109.5 / 3300.4 | 140.3 / 293.4 |

This is approximately 22.2× faster for that preparation stage, not a claim of 22.2× faster complete startup. Binary resources total 103,958,052 bytes across eight assets. The build also retains the original OBJ fallback resources.

A fresh geometry-cache identity required 1464.1 ms for worker preparation in the material-edit check. Five subsequent different material values took 774.4 ms median, 862.0 ms maximum. Every transport buffer matched a direct CPU build bitwise. Full-cache reuse was also measured before splitting geometry/transport storage (five repeats: 90.1, 102.3, 97.4, 85.4, 72.7 ms); those earlier numbers are not a final split-cache timing claim.

Five complete new-app RGB PT startups used Rastagotchi, its default glass/wear material, open scene with ground, studio_small_09 HDR 1024, seed 17, depth 16, requested 76,800 pixels, denoiser off, one target sample. Actual size was 297×258 with uniform one-sample counts.

| Stage | Median, ms | Maximum, ms |
| --- | ---: | ---: |
| Model ready | 136.2 | 179.8 |
| Scene ready | 215.6 | 304.7 |
| First preview | 2071.0 | 2928.1 |
| First requested-mode image | 2601.7 | 3548.3 |

These five starts had warmed browser/native shader caches. The original app's successful first observed start took 31,106 ms to its target image; a subsequent original start failed with a destroyed world-triangle buffer. This does **not** support a comparable five-run old/new startup speedup or a cold-start p95 claim. Navigation automation twice timed out at 20 seconds despite completed render telemetry; the table measures the application's startup clock, not navigation-tool completion.

Unique-source kernel preparation measurements were 19,142 ms for the shared generic dielectric candidate, 14,778 ms for its RGB specialization, 20,625 ms for RGB specialization without shared call sites, and 24,174 ms for the spectral specialization. These are individual first-source pipeline-pair measurements, not five fresh-driver-cache full-app measurements. Native first-dispatch compilation can still occur after createComputePipelineAsync resolves.

## Render throughput and quality

Quality gates: NRMSE ≤ 1e-6 and relative energy error ≤ 1e-5; buffer-only changes must be bitwise exact. A failed render is never a timing sample. When comparing five samples, the reported maximum is the nearest-rank p95. Pair candidates in one uninterrupted session, reuse each compiled pipeline, and warm up before timing.

The shared dielectric branch matched all 24 sphere cases (thin/volume, clean/worn, RGB/spectral, seeds 17/29/83) bitwise. Selected RGB source matched all four built-in models, clean/worn, seeds 17/29/83, at 160×120, depth 16, four samples. Five interleaved repeats at 640×480, four samples, comparing original generic, original RGB-specialized and selected RGB kernels, also matched bitwise throughout. Consequently all image regions have zero energy difference for these accepted comparisons.

| Model / wear | Original median / max, ms | Selected median / max, ms |
| --- | ---: | ---: |
| High-poly Suzanne / clean | 1904.6 / 1943.6 | 1885.6 / 2018.1 |
| High-poly Suzanne / worn | 2558.9 / 2670.6 | 2547.7 / 2637.6 |
| Rastagotchi / clean | 2390.7 / 2474.0 | 2393.5 / 2415.3 |
| Rastagotchi / worn | 2807.9 / 2916.0 | 2852.1 / 3041.0 |
| Buddha / clean | 3193.7 / 3290.7 | 2962.9 / 3119.9 |
| Buddha / worn | 5235.2 / 5275.2 | 5309.9 / 5414.4 |

The selected kernel primarily reduces preparation cost. It gives approximately 7.2% throughput improvement in the clean Buddha case; it is not a universal FPS improvement. Managed GPU allocation remained unchanged for source-only candidates; it excludes JS heaps, native pipeline/compiler memory and driver overhead.

## Alternatives screened

| Candidate | Outcome |
| --- | --- |
| Workgroups 8×4, 8×8, 16×8, 16×16 | Exact tested images; no consistent end-to-end gain. Keep 8×8. |
| Tiles 32/64/128/256 and packet targets 4/8/16 ms | Exact tested images; no robust additional improvement over the existing calibrated scheduler. Keep Intel's existing 128 minimum. |
| SAH leaf sizes 2/8/16 | NRMSE 5.37e-4 / 2.54e-4 / 4.05e-2; reject. Light CDF order was preserved. Keep leaf size 4. |
| Full-precision wide BVH 4/8 | Failed medium-boundary transport; no successful timing comparison. Reject. |
| Geometry/normal structure-of-arrays packing | Same 96 bytes per triangle; NRMSE 0.119. Reject. |
| Full-medium-state wavefront | Sphere median about 2.22× slower; +6,946,928 bytes of state/queues. NRMSE 6.41e-7. Reject on cost. |
| Hybrid primary-init plus full trace | Single pair appeared faster, but NRMSE 4.13e-4 and energy error 3.20e-5. Reject before repeat timing. |
| SPPM CSR count/scan/scatter | Sphere median approximately 5.6% slower; +333,824 bytes, p95 regression >5%. Reject. |
| SPPM gather wear hoist | Median +6.3%, maximum +14.7%; negligible atomic-rounding differences. Reject. |
| Precomputed Owen hash constants | Bitwise exact five-pair reused-pipeline test; median +4.4%, maximum +5.3%. Reject. |
| Precomputed fingerprint/axis wear hashes | Failed image gate. Initial repeated-pipeline timing series was invalid; no throughput claim. Reject. |
| Omit presentation work, upper-bound experiment only | First pair showed an unstable render epoch and is invalid. Remaining four exact pairs showed no consistent benefit. No display/copy rewrite adopted. |
| SPPM batch 4096 / 8192 versus 1024 | Sphere, two iterations, 32,768 emitted photons: median 1197.5→497.7 ms and 1189.6→369.5 ms; NRMSE <9e-9. Managed allocation 4.71→9.67 / 16.29 MB. Tested configuration tradeoff, not an automatic change: extra allocation may reduce fitted image resolution under a fixed budget. |
| Threaded/stack traversal and reciprocal bounds | Existing calibrated Intel path and portable fallback retained. No new unvalidated traversal substitution. |

Rejected prototypes are accessible only through benchmark imports in scripts; they are not installed in the application.

## Verification and remaining limitations

- `npm test`: 26 files, 123 tests passed.
- `npm run build`: passed, including generated assets and TypeScript checking.
- Browser verified all four models' cached-geometry material packing bitwise against the direct CPU path.
- Browser checked cache round trips, damaged records and blocked storage fallback.
- Browser checked pause/resume, latest-wins rapid RGB/spectral switching, uniform two-sample completion, PNG 297×258 and PFM export.
- Forced device destruction created a replacement device; resuming completed two samples without an error.
- Independent GPU rough-dielectric quadrature/reciprocity checks passed all 16 cases, with no invalid outputs. Wear checks passed energy/PDF/side/transform controls; cleanDifference=0. Transport queue sparse/dense checks had no missed, duplicated or unexpected entries. Rough SPPM analytic control had zero errors and maximum error 1.49e-5. Glass plate checks outside/inside matched analytic RGB means with zero errors.

Two issues prevent a blanket determinism or all-profile success claim:

1. Independent sessions sometimes change a small set of raw PT pixels and runtime even with the unmodified original renderer/shaders. The full startup old/new PFM comparison did not pass the quality gate (NRMSE 0.551), and two new-app sessions also differed (NRMSE 0.476, 156 channels). These are recorded counterexamples, not accepted-quality evidence. No root cause or driver attribution is established; selected-source acceptance rests on the controlled, uninterrupted paired matrix above.
2. Actual Rastagotchi Quality (spectral SPPM, depth 32, seed 1, 520×452 under the existing budget) still fails an intersection check in camera iteration 0. The original commit also failed this same profile: 99 operations, pixel 78272 depth 3; the new version reported 97, pixel 93383 depth 2. Original verification deliberately delayed device creation by 15 seconds to avoid its startup ownership race, so its duration is excluded from timing. Do not count either failed SPPM render as a performance result. Escape dismisses the error overlay.

This work does not resolve those transport/reproducibility issues and does not certify every browser, adapter or possible optimization.

## Reproduction and evidence

- `scripts/prepare-models.mjs`: generation with source/implementation fingerprints and checksums.
- `scripts/performance-baseline.mjs`: read-only Git snapshot; maps extensionless imports and cache-busts snapshot modules.
- `scripts/performance-connected.mjs`: serial connected-browser session, compiled-kernel selection, raw Float32 capture, GPU/completion timing.
- `performance-2026-10-06.json`: measured rows, quality differences, errors and browser controls.
- `performance-2026-10-06-hashes.json`: source hashes and resource manifest/checksums.
- Local ignored raw PFM/metadata exports: `test-results/performance/old-cornell-rastagotchi-rgb-pt-1.pfm` and `new-cornell-rastagotchi-rgb-pt-1.pfm`; earlier raw reference arrays and detailed screening artifacts are also under `test-results/performance`.

