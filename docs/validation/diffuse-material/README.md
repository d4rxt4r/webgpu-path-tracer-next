# Diffuse material validation — 2026-10-09

Local adapter: `intel gen-12lp`, Windows, connected Chrome 154. Results apply to the configurations recorded here, not to other adapters.

## CPU and build

157 tests in 33 files passed, including four new tests covering linear color/albedo/spectra, Lambert byte compatibility, bounds/export, UI state and links, and independent reciprocity/energy quadrature (32768 directions per case, roughness 0/0.01/0.1/0.5/1 and normal/mid/grazing viewing directions). TypeScript and direct Vite production build passed. Model manifest generation was bypassed; the tracked manifest is unchanged. No commit or push was made for this extension.

## Numerical GPU checks

- [BSDF and gather](bsdf-gather.json): 24 BSDF cases, including six normalized Oren-Nayar cases (roughness 0.2/0.6/1, normal/grazing, 32768 samples each). New-case invalid count and PDF mismatch are zero; reciprocity error is at most 2.16e-7, quadrature/sample energy difference below 7.2e-6, and integrated cosine PDF is 0.99999999. The previous 18 opaque cases have exactly the same sampled energies as the earlier saved baseline. Actual SPPM hash/gather/update for kind 10 matches the independent CPU normal-incidence formula within 3.18e-7; counts are 2/3/1/0. The corrupt-link fixture reports its expected diagnostic.
- [Transport metrics](transport-metrics.json), [raw linear RGB](transport.raw.json), [images](transport-contact-sheet.png): 16 rows covering RGB/spectral, white/blue at roughness 0/0.5/1, black albedo and full white albedo. PT and production SPPM use 16x16, seed 17, 128 samples/iterations, 128 photons per iteration/batch, depth 2. All pixels finite and all transport errors zero. Precise PT repeated identically; ordinary/precise SPPM matched exactly. PT ordinary/precise aggregate relative L1 is below 0.006%. PT/SPPM mean relative L1 is below 0.012% RGB and 1.413% spectral at this small sample count.
- [Longer spectral comparison](convergence-metrics.json), [raw pixels](convergence.raw.json), [images](convergence-contact-sheet.png): white roughness 1 and blue roughness 0.5, 2048 samples/iterations, otherwise the same configuration. PT/SPPM relative mean differences are below 0.020%; repeated precise PT pixels match exactly. All transport errors zero.

Individual PNG and PFM files accompany each matrix row. PNGs use Reinhard plus gamma 2.2 for inspection; JSON/PFM retain linear RGB, including negative spectral estimates. SPPM accumulation XYZ is converted to linear RGB before comparison. `gpuMs` is GPU timestamp duration, while `completionMs` is wall-clock completion excluding compilation. The broad matrix and convergence runs disable SPPM per-pass timing; their SPPM `gpuMs` values are explicitly null. PT timestamps remain enabled.

The directly lit plane checks direct transport and continuation; the separate gather fixture checks indirect accumulation. These are targeted numerical fixtures, not independent PBRT image references or a complete built-in-scene regression. Earlier matrix/convergence results precede the SPPM underflow guard described below; that guard changes only kind-10 behavior when positive CPU roughness rounds to zero on the GPU.

## Connected browser

[Settings screenshot](settings.png) shows all diffuse controls with a 10px grid gap. Palette #2865d4 synchronized RGB to 40/101/212; numeric R=80 produced #5065d4. Switching material types preserved color and roughness 0.5. A link created while diffuse settings were hidden restored them on a new page in the same connected browser. Middle-button `auxclick` handlers reset R to 255 and roughness to zero. The denoiser rendered the edited diffuse object without a visible error.

[Actual exported JSON](export-metadata.json) contains the effective material metadata and every diffuse control alongside hidden material groups. The export was captured from the application's generated download; no JSON import UI is claimed. The screenshot is a low-resolution UI check, not a high-sample beauty image.

Browser specifications were added, but the complete Playwright suite was not launched. UI actions and numerical runners were exercised through the connected Chrome DevTools browser. Filesystem watching ignored assets to avoid unrelated OBJ events interrupting GPU work.

## Tiny positive roughness

SPPM handles kind 10 as a diffuse visible point even if its positive CPU roughness underflows to zero in f32. The diffuse point never receives smooth plastic's factor of two; photon storage likewise remains enabled. This preserves the Lambert limit for values such as 1e-50 without introducing a mirror event.

[Final guard/filter/timing acceptance](final-metrics.json), [raw and filtered pixels](final.raw.json), [images](final-contact-sheet.png): tiny positive roughness 1e-50 on white and ordinary blue roughness 0.5, both RGB/spectral, 128 samples/iterations with the same seed/resolution/depth/photon settings. All raw and denoised pixels finite; all errors zero. Precise PT repeats and ordinary/precise SPPM agree exactly. Tiny-roughness PT/SPPM means are identical to the recorded Lambert case for the same mode. The blue case retains the previous matrix means.

| Material/mode | PT GPU ms | PT completion ms | SPPM GPU ms | SPPM completion ms |
| --- | ---: | ---: | ---: | ---: |
| Tiny / RGB | 55.25 | 60.5 | 411.96 | 2099.3 |
| Tiny / spectral | 95.75 | 98.4 | 305.00 | 2122.9 |
| Blue 0.5 / RGB | 21.30 | 23.2 | 198.84 | 2098.2 |
| Blue 0.5 / spectral | 95.22 | 99.4 | 228.98 | 2103.8 |

SPPM timestamps sum its rendering passes; completion includes per-pass readback overhead. Both timings exclude the subsequent denoiser, which was checked separately for finite output using three passes, strength 2 and filterGlass=false. The denoiser also returns XYZ in spectral mode; the saved filtered arrays and PNGs are converted to linear RGB. Tiny-fixture timings are not a production throughput benchmark. Browser console showed no JavaScript errors; it did show adapter powerPreference warnings and an external-instance warning during hot reload/recovery. Subsequent rendering and numerical acceptance completed successfully.
