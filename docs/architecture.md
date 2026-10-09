# Architecture

## Scene preparation

`src/scene` describes geometry, materials, lights, camera and environment. OBJ parsing/repair and geometry preparation run through workers. CPU software BVH construction and material packing in `src/accel` produce GPU buffers; shell identity and camera medium classification are retained separately from shading normals. The editor currently edits one demonstration object, not an arbitrary multi-object scene graph.

`src/assets` contains bundled asset loaders, IndexedDB persistent storage and prepared geometry/BVH caches. Cache keys include preparation and material/transport dependencies. Damaged or unavailable persistent storage falls back to preparation. Material changes reuse geometry where possible; implementation/layout changes invalidate dependent prepared entries.

## Transport

`src/transport` shares WGSL camera, intersection, lighting, material and sampling helpers. PT supports direct light sampling, MIS, emission and continuation. SPPM performs camera visible-point tracing, photon tracing, spatial hash gathering and progressive radius/flux updates. First diffuse photon hits are excluded from gathering because camera NEE accounts for direct illumination. Delta events continue tracing rather than becoming ordinary gather points.

RGB and spectral shader variants share the scene contracts. Spectral paths sample wavelengths over 360-830 nm and accumulate XYZ, converted to linear RGB for display/export. Reflectance and illuminant reconstruction from RGB are approximations; conductor presets use measured eta/k tables. Sobol dimensions and seeds are retained through precise intersection and transport replay paths.

Medium tracking preserves shell identity, insertion order and signed winding, with common capacity 32 and precise replay for overflow/transport recovery. Recovery must not lose or duplicate samples. Nested closed shells are supported; coincident surfaces and self-intersections are not.

Camera rays share a thin-lens implementation for PT/SPPM. Missing or zero aperture preserves pinhole behavior. Lens samples use Sobol dimensions 510/511. Focus points are world-space; picking uses the packed CPU BVH. A camera aperture crossing a volumetric boundary is rejected while retaining the accepted camera. Diagnostic geometry rays remain pinhole.

## Scheduling and resources

`src/render` owns progressive integrators, compute packets, diagnostics and denoising; `src/gpu` owns device, uploaded scene/environment and timers. Image sizing combines pixel budget, memory budget and device limits. GPU allocation/brightness validation occurs before committing replacements. Device recovery recreates resources from retained CPU data; stale asynchronous work must not replace newer state.

Pipelines are selected/specialized for transport mode and active wear effects. Variant caches retain two ready wear variants per pipeline family. Compute work is submitted in packets to keep the browser responsive; GPU timestamps measure GPU work separately from completion/readback and pipeline preparation.

## Editor and display

`src/app` binds numeric settings, sliders, resets, hidden material groups, URL settings and export metadata. Numeric inputs may exceed convenient slider scales within validated limits; slider movement replaces the value with one on its scale. Middle click restores the field default.

Denoiser guides describe surface geometry/materials. A-trous and bilateral can update during accumulation; spatial NLM applies on pause. Glass filtering has off/surface/image modes, independent strength, blend and comparison. Raw accumulation remains independent of filtering/exposure/tone mapping. Export waits for the required display preparation.

See [materials](materials.md), [environment](environment.md) and [verification](verification.md) for detailed behavior and limitations.
