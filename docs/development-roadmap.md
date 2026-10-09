# Development roadmap

Consolidated against the checkout following `b9e58d4` on 2026-10-09. These are remaining tasks, not completed fixes. Current material, camera, wear, denoiser and cache capabilities are documented separately.

## Correctness and repeatable evidence

- Reproduce and classify high-poly/Quality intersection reports on fixed geometry and settings. Historical reports include Suzanne at 817x375 and Rastagotchi spectral SPPM, depth 32, seed 1, 520x452, camera iteration 0. Later targeted checks do not establish that every such case is fixed. Preserve internal error codes and add an independent CPU comparison for any fix.
- Investigate raw PT differences between independent sessions reported during the 2026-10-06 startup study. Controlled paired runs passed, but that does not explain cross-session differences or identify a driver cause.
- Classify the full browser suite on a recorded adapter. Review old UI fixtures, readiness timeouts and OBJ route interceptions; include no-WebGPU startup, HDR replacement, cancelled loads, budget rejection and device recovery. Early WebGPU layout initialization remains a review target.
- Generate independent references for current geometry with source/scene hashes, multiple seeds and declared ROI. Targeted plane/BSDF/gather checks do not replace glass/caustic convergence or a built-in-model regression matrix.
- Add unit checks before deployment build. The current Pages workflow builds on `main`; ordinary development commits here use `master`. Reconcile deployment triggers explicitly when changing CI.

## Quality and resources

- Compare raw glass/caustics/spectral output against stable independent references before tuning filters. Existing denoiser results use a noisy, correlated 32-sample guide; full-frame error sometimes increases.
- Measure first useful frame, compilation, memory peaks, readback and recovery separately. Keep only optimizations that pass image gates and controlled timing comparisons. Existing startup caches and specialization are already implemented.
- Broaden HDR GPU acceptance and lifecycle coverage; available diagnostic modules are not proof of full automated acceptance.

## Product development

- UV base-color/roughness textures with correct color spaces, mip filtering and budgets; then normal/emission maps.
- Static GLB import, followed by needed PBR extensions; multiple objects, instances and BLAS/TLAS without duplicated geometry.
- Physical conductor presets, custom metal, plastic and reflecting emission are implemented. Anisotropy, multilayer coating and volume scattering remain future work, subject to a separate specification.

Use [verification](verification.md) to distinguish recorded acceptance from proposed work. No old audit count or failure is presented as a new run.
