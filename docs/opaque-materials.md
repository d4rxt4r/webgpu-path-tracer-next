# Metal, plastic and reflecting emitters

The material editor preserves each group when switching types. Metal presets are aluminum, gold, copper and silver (complex Fresnel, isotropic GGX); Custom uses a linear RGB F0 with Schlick Fresnel and the existing bounded nonnegative spectral reconstruction. Its first color comes from the previous preset at normal incidence. The palette is authoritative when restoring links; RGB channels synchronize to it. The initial channel defaults are retained independently in `metal-color-default`, including in URLs and exported JSON. A restored initialized custom color is never replaced by a preset.

Plastic uses Ashikhmin-Shirley FresnelBlend with GGX and an IOR-derived neutral F0. Default color is #4f87c5, roughness 0.2 and IOR 1.5. A smooth surface retains a discrete mirror event alongside the diffuse component.

Reflecting emitters have separate diffuse reflectance and emission spectra. Defaults are #808080, white emission and power 10. The convenient power slider spans 0–40; the numeric input retains larger accepted values. Packing rejects nonfinite spectra and overflowing RGB/spectral photon flux before replacing the current scene. At power zero the base still reflects and the triangles are excluded from light sampling. Pure legacy emitters retain their terminating behavior. Emission uses outward geometric normals and the environment illuminant reconstruction.

PT, spectral PT, SPPM camera/photon transport and precise paths share `opaque.wgsl`. Rough opaque points gather the evaluated BRDF; mirror events continue. Direct photon hits are excluded because camera NEE estimates them. The original seven Sobol slots per bounce remain unchanged. The existing material buffer and its two spectral slots accommodate the new kinds (6 physical metal, 7 custom metal, 8 plastic, 9 reflecting emitter); geometry, diagnostics and denoiser guides retain their layouts. Prepared transport keys include conductor data and packing dependencies.

PBRT export writes conductor eta/k tables and reflecting emitter bases. It rejects custom Schlick metal and FresnelBlend plastic with an explicit explanation. Surface wear remains limited to the existing dielectric.

## Sources

- [Pinned PBRT tables and license](licenses/conductor-data.md).
- [Conductor BRDF](https://www.pbr-book.org/4ed/Reflection_Models/Conductor_BRDF).
- [Ashikhmin-Shirley FresnelBlend](https://www.pbr-book.org/3ed-2018/Reflection_Models/Fresnel_Incidence_Effects).

## Reproducible checks

`npm test`, `npm exec tsc -- --noEmit`, `npm exec vite -- build` (the latter deliberately bypasses model manifest generation).

Connected-browser numerical runners: `verifyOpaqueBsdf` in `src/debug/verify-opaque-bsdf.ts`, `verifyOpaqueGather` in `src/debug/verify-opaque-gather.ts`, and `verifyOpaqueTransport` in `src/debug/verify-opaque-transport.ts`. The transport fixture compares a directly lit plane, so the separate gather fixture checks indirect photon accumulation against a CPU formula. These are targeted acceptance fixtures, not independent renderer reference images.

Validation results and their limits are recorded separately in `docs/validation/opaque-materials/`.
