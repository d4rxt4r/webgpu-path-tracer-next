# Opaque material validation, 2026-10-09

Local adapter: `intel gen-12lp`, Windows, connected Chrome 154. These results do not establish performance or correctness on other adapters.

## Static and CPU

153 tests in 32 files passed; TypeScript and Vite production build passed. Vite was invoked directly to avoid regenerating the tracked model manifest. Existing material tests remain in this suite. The preceding numeric/UI work was committed and pushed as `d93dea3`; material changes remain local.

## GPU

- [BSDF results](../../opaque-bsdf-validation.json): 18 shared-shader conductor/custom/plastic cases, roughness 0.2/0.6/1, normal/grazing directions, 32768 samples each. No invalid values; reciprocity error at most 3.52e-6, PDF mismatch zero, energy versus independent quadrature within 0.003 and integrated PDF mass within 0.002.
- [Gather results](gather.json): actual SPPM hash/gather/update for kinds 6/7/8, photon counts 2/3/1/0, maximum numerical difference 3.55e-7. Intentional corrupt-link case reports the expected diagnostic.
- [Transport metrics](transport-metrics.json), [raw linear pixels](transport.raw.json), [contact sheet](transport-contact-sheet.png): 32 cases, four physical presets at roughness 0/0.6, custom 0/0.6, plastic 0/0.6 and IOR 1/2.5, reflecting emitter power 0/10, each RGB/spectral. PT and production SPPM, 16x16, seed 17, 128 samples/iterations, 128 photons per iteration/batch, depth 2. All pixels finite; all transport error counts zero. Individual PNG and linear PFM files accompany every integrator/case.

`gpuMs` is the GPU timestamp duration; `completionMs` is wall-clock submission/completion time, excluding pipeline compilation. SPPM timestamps sum all passes and include synchronization overhead only in completion time. These tiny fixtures are correctness checks, not throughput benchmarks. PNGs use Reinhard and gamma 2.2 for inspection; PFM/JSON preserve linear values, including negative converted RGB spectral estimates.

RGB PT/SPPM mean relative L1 difference is below 0.078%; spectral difference is below 1.72% at 128 iterations with different wavelength streams. SPPM accumulation XYZ is converted to linear RGB before comparison and saving images. An initial diagnostic compared different spaces; the saved artifacts and metrics were corrected. Ordinary versus precise SPPM images matched exactly. Ordinary versus precise PT can differ at individual pixels: maximum 0.5123 for the spectral power-10 emitter, while RGB aggregate means remain close. This comparison is different from repeating the same pipeline; it is not evidence of bitwise equality between intersection implementations.

The transport plane is directly illuminated and does not validate indirect convergence in complex scenes; indirect accumulation is covered separately by the gather fixture. No independent PBRT image comparison or full built-in-model GPU regression matrix was completed.

[Existing GPU acceptance runners](legacy-gpu.json) also passed: RGB diffuse light/BSDF/MIS estimates versus independent area quadrature (maximum relative difference below 0.026%), Sobol comparison exact, light PDF error below 7.7e-7, roulette within 0.64%; spectral D65 and narrow red/blue emitters versus spectral integration, diffuse light/BSDF/MIS versus quadrature, and prism dispersion (angle error below 5.4e-7 radians, constant-IOR spread zero). All reported transport errors were zero. These protect targeted old-material behavior, rather than establishing a full image regression over every built-in scene.

[Longer spectral comparison](convergence-metrics.json), [linear pixels](convergence.raw.json), [contact sheet](convergence-contact-sheet.png): gold mirror, custom metal roughness 0.6, plastic roughness 0.6 and power-10 reflecting emitter, 2048 samples/iterations, otherwise the same fixture/configuration. SPPM per-pass timestamps were disabled for this convergence run; completion times are saved independently (about 2.7–3.1 seconds, excluding compilation). All errors zero and all pixels finite. PT/SPPM mean relative L1 differences are 0.0038%, 0.0336%, 0.0135% and 0.0050% respectively. Repeating the precise PT pipeline with identical seed/configuration produced exactly identical pixels in all four cases. Cold compilation and interrupted preliminary runs are not included as completed measurements.

## Connected browser

[Settings screenshot](settings.png) visually verifies spaced controls; visible groups have a 10px grid gap. Preset/custom transitions, palette/RGB synchronization, retained custom default, middle-button channel reset, hidden plastic IOR and emission power surviving link reload were exercised. Numeric power 80 remains 80 while the slider stops at 40. [Actual exported JSON](export-metadata.json) retains hidden controls and custom channel defaults.

HDR `Studio small 09` loaded at 2048x1024; footer and denoiser were checked in the live page. An intentional input of `3e38` produced `Emitter flux exceeds GPU limits`, restored the previous valid power 80 and retained the scene. The test error was dismissed. The only network error observed was the missing favicon (404); no JavaScript/WebGPU error was observed in these checks.

The browser test specifications were updated/added, but the complete Playwright suite was not launched. The checks above were run through the connected browser and the exported numerical runners. A separate Vite instance with watching disabled avoided unrelated model-file filesystem events interrupting long GPU jobs.
