# Verification

## Running checks

```sh
npm test
npm exec tsc -- --noEmit
npm exec vite -- build
npm run test:browser
```

Direct Vite build avoids regenerating the tracked model manifest. Playwright uses installed Chrome, one worker and a managed dev server. A CPU/build pass does not establish GPU/browser acceptance. Record adapter/browser, source revision, scene hashes, resolution, seed, depth, samples/iterations and photon configuration for every GPU run. Separate GPU timestamps, completion/readback time and compilation; spectral SPPM output is XYZ and must be converted before linear-RGB comparisons.

Generated output is ignored under `artifacts/validation/`. Capture scripts retain their existing stage-based filenames. Use distinct benchmark `--tag` values; `--compare <tag>` reads the corresponding local performance directory. Historical full reports/images are recoverable from Git `b9e58d4`, not installed as current references.

```sh
npm run benchmark -- --tag my-run
npm run validate:runtime
npm run validate:quality -- --pbrt <PBRT-v4-executable> --output artifacts/validation/my-quality-run
npm run validate:quality -- --reuse-reference --reference-dir artifacts/validation/my-quality-run --output artifacts/validation/my-comparison
npm run validate:spectral-sppm -- --pbrt <PBRT-v4-executable>
```

Reference reuse requires `--reference-dir`, a separate output directory and compatible source/scene metadata. A fresh PBRT run generates its own references. Missing or incompatible references fail; no fallback to deleted documentation artifacts is provided. Runtime validation also needs its browser/OpenSSL prerequisites; inspect script options before launching. Capture/acceptance commands can be expensive and are not part of the CPU suite.

## Retained acceptance: materials and numeric controls, 2026-10-09

Source snapshots and full evidence: Git `b9e58d4`. Windows, connected Chrome 154, Intel gen-12lp. Final CPU suite: 157 tests in 33 files, TypeScript and direct Vite build passed. These historical runs are not repeated by documentation cleanup.

- Opaque BSDF: 18 conductor/custom/plastic cases, roughness 0.2/0.6/1, normal/grazing, 32768 samples each. Invalid values/PDF mismatches zero; reciprocity error <=3.52e-6, energy versus independent quadrature difference <0.003. SPPM gather kinds 6/7/8 matched CPU within 3.55e-7; intentional corrupt links reported the expected error.
- Opaque transport: 32 RGB/spectral rows, PT/SPPM, 16x16, seed 17, depth 2, 128 samples/iterations and 128 photons per iteration/batch. Physical/custom metals at zero/nonzero roughness, plastic IOR 1/2.5 and reflecting emitter power 0/10 all finite with zero transport errors. PT/SPPM mean relative L1 <0.078% RGB and <1.72% spectral. Ordinary/precise SPPM matched exactly; ordinary/precise PT was not bitwise equal in every case.
- Opaque spectral convergence: gold mirror, custom roughness 0.6, plastic roughness 0.6 and reflecting emitter power 10, otherwise the same fixture at 2048 samples/iterations. Mean PT/SPPM differences respectively 0.0038%, 0.0336%, 0.0135%, 0.0050%; precise PT repeats exact, errors zero.
- Diffuse: six additional normalized Oren-Nayar BSDF cases; reciprocity <=2.16e-7, energy difference <7.2e-6, PDF mismatches/invalid values zero. Previous 18 case energies unchanged. Kind-10 gather matched CPU within 3.18e-7. Sixteen transport rows (white/blue, roughness 0/0.5/1, albedo 0/1) used the same 128-sample configuration; errors zero, PT/SPPM mean differences <0.012% RGB and <1.413% spectral. White roughness 1 and blue 0.5 at 2048 spectral samples differed by <0.020%.
- Final diffuse underflow check: roughness 1e-50 and blue 0.5, both modes at 128 samples with the same fixture. Raw/denoised values finite, errors zero, precise PT repeat and ordinary/precise SPPM exact. Tiny-roughness means matched Lambert. Filtering: three passes, strength 2, glass off.

| Final diffuse fixture | PT GPU / completion ms | SPPM GPU / completion ms |
| --- | ---: | ---: |
| Tiny / RGB | 55.25 / 60.5 | 411.96 / 2099.3 |
| Tiny / spectral | 95.75 / 98.4 | 305.00 / 2122.9 |
| Blue 0.5 / RGB | 21.30 / 23.2 | 198.84 / 2098.2 |
| Blue 0.5 / spectral | 95.22 / 99.4 | 228.98 / 2103.8 |

These are tiny correctness fixtures, not production throughput benchmarks. SPPM completion includes per-pass diagnostic readback; filtering/compilation excluded. Earlier convergence runs disabled SPPM per-pass timestamps. Directly lit planes plus separate gather checks do not establish complex indirect convergence, independent PBRT image quality or all built-in models.

Connected-browser checks covered palette/RGB synchronization, material retention, hidden-group URL reload, middle resets, custom metal defaults, actual exported JSON, HDR, footer and denoiser. Emission power 80 was retained beyond slider 40. Intentional power 3e38 produced `Emitter flux exceeds GPU limits`, restored 80 and preserved the scene. Numeric budgets 4096/8192/16384 MiB survived links; reset returned 192. Budget is a limit, not an allocation/speed promise. All ten extended numeric fields round-tripped in DOM. Complete Playwright suite was not launched. Adapter powerPreference, favicon and hot-reload external-instance warnings were observed; subsequent acceptance completed.

Reproduce with the exported `verifyOpaqueBsdf`, `verifyOpaqueGather` and `verifyOpaqueTransport` runners in `src/debug`; their options specify the fixture. Existing transport/spectral runners also passed targeted diffuse MIS, light PDF, Sobol, emitter and prism checks. This is targeted old-material protection, not a complete scene regression.

## Camera, denoiser and wear, 2026-10-08

Connected Chrome, Intel gen-12lp; full historical reports are in `b9e58d4`.

- Camera: 48x48, seed 17, depth 8, 16 PT samples/SPPM iterations, 1024 photons/iteration, batch 512; RGB/spectral with disabled/zero/circular/polygonal lenses. Errors/nonfinite values zero. PT disabled/zero matched the independent previous pinhole expression exactly; raw SPPM differences <=2.98e-8, equal after FP16 rounding. Geometry: 4096 rays/configuration, 20/100 mm circle and 3/6/12 blades; focus error <2.6e-7 m. Nested-glass replay at 4x4, two iterations, depth 8, 256 photons/iteration, 20 mm polygon matched common/precise exactly. UI covered distance 12/25/100 m, picking, link/reset and rejected boundary-crossing aperture.
- Denoiser: ten PT/SPPM RGB/spectral glass cases, 160x120, seed 17, depth 12; shared four-sample source and correlated 32-sample guide, SPPM 4096 photons/iteration, batch 1024. Raw remained bitwise unchanged, output finite, GPU validation errors zero. All three filters reduced MSE in the central glass rectangle, but full-frame MSE sometimes increased. This is neither an independent reference nor a convergence claim. GPU timestamp ranges: a-trous 0.262-0.328 ms, bilateral 0.066-0.197 ms, NLM 1.049-1.507 ms; completion/readback respectively 6.8-10.1, 4.6-9.5, 5.4-11.7 ms, guide generation excluded. Five selected browser checks passed; no full-suite claim.
- Wear: 128x128 grid, 21 cases; finite normal/BSDF, normal-length error <=1e-5, PDF agreement. Seed/scale affected active patterns; inactive seed diff zero; masks 0/1/2/4 matched generic shading bitwise. Physical-space transformed-point differences <=2.57e-6 roughness and <=4.67e-7 normal. UI spectral SPPM at 129x147, depth 8, four iterations, 1024 photons/batch with all effects and denoise had no errors. This early accumulation does not prove convergence. Surface-only microtest GPU timestamps: generic clean 0.147456 ms, all effects 0.393216 ms, specialized clean 0.032768 ms; quantized single-run measurements are not frame benchmarks.

Reproduction: `tests/browser/denoise.spec.ts`, `surface-wear.spec.ts`, `settings-link.spec.ts` and `diffuse-material.spec.ts`. Denoise matrix runner: `/tests/fixtures/denoise.html`, import `/src/debug/compare-denoise.ts`, call `compareDenoise({integrator, mode, roughness, low:4, reference:32})`; run cases sequentially.

## Medium tracking and startup, 2026-10-06

Intel gen-12lp results apply only to recorded configurations. Source baseline for medium comparisons: `d19b2f9`; final long comparisons used original always-precise transport as a numerical reference, not a successful previous common-kernel speed baseline.

Medium validation covered capacities 2/4/8/32, nine shell cases, fourteen RGB/spectral overflow replays, dense queues and pause/resume. Twelve long Control/Rastagotchi comparisons at 320x240, depth 8, seeds 1/17/29, 128 iterations and 16384 photons/iteration completed with zero errors; maximum relative RMSE raw 0.08891%, floor ROI 0.26092%, filtered 0.01683%. Default capacity 32 was retained. Failed original common-kernel intersection runs cannot support speed improvements; historical 0.2/0.4-second targets were not reproduced.

Controlled startup-source comparisons matched bitwise across sphere thin/volume/clean/worn and built-in RGB PT cases. Browser cache fallback, latest-wins switching, export and forced device recovery were checked. Source specialization mainly reduced preparation; there is no universal FPS improvement. Independent-session PT differences and Rastagotchi Quality intersection failures remained unresolved in that study; see [roadmap](development-roadmap.md).

Reproduce through `benchmarkMedia`, `verifyMediumState`, `verifyMediumReplay`, `verifyShells`, `verifyTransportQueue` and `verifyTransportReplay` in `src/debug`. `node scripts/media-artifacts.mjs` writes to the local artifacts directory. Reuse one GPU device for a small matrix and reload a quiet page between groups when external-instance errors occur; interrupted cases are not completed checks.

## Documentation cleanup

The consolidation changes documentation and diagnostic filesystem paths only. Repeated on 2026-10-09: 157 CPU tests in 33 files passed, TypeScript and direct Vite production build passed, syntax checks passed for all nine changed diagnostic scripts. Three PBRT reference-argument guards passed without starting a browser/GPU. Local Markdown links, UTF-8, ignored artifact paths and diff whitespace checks passed; the tracked model manifest is unchanged. No fresh GPU/browser run was performed.
