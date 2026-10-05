# Environment illumination

Cornell remains the default scene. The open layout retains the object, its transform, and the camera, hides the room, and optionally enables a 10 m ground plane at Y=0. The first switch to open selects Studio Small 09 and disables the ceiling lamp. Ground and lamp visibility are independent settings.

The environment source is off, a constant linear RGB radiance, or an equirectangular Radiance HDR panorama. Color/tint, illumination strength, and Y rotation affect transport. Background visibility, exposure, and mip blur affect only primary camera misses. A hidden background is black; reflections and refractions continue to use the sharp lighting map. The background exposure is independent of illumination strength.

Local uploads accept modern scanline RLE or flat RGBE, either axis order and orientation, a 2:1 aspect ratio, at most 8192×4096 and 128 MiB. Decode and solid-angle weighted downsampling run in a cancellable Worker. Selected GPU widths are 1024, 2048 (default), and 4096; smaller source images retain their resolution. Failed loads or allocations retain the previously committed environment. Presets are original 4K files; source and license details are in `assets/hdr/README.md`.

HDR radiance and its mip levels use RGBA32F textures with manual bilinear/trilinear filtering. A texture stores a marginal row CDF, conditional column CDF, and solid-angle PDF. Its proposal includes uniform support, so bilinear radiance and tint changes never acquire zero sampling probability. No additional storage buffers, filtering feature, or adapter minimum limits are required. HDR textures, CDF, spectral bases, and uniforms participate in the existing memory budget; the default remains 192 MiB. 4K normally needs a larger budget.

PT uses a power weighted mixture of area and environment lights for NEE and accounts for its probabilities in MIS at emitter hits and environment misses. SPPM uses the same direct-light proposal and emits environment photons from a disk covering the visible geometry's bounding sphere. Photon power is compensated for source choice, direction PDF, and disk area. The first diffuse photon hit stays excluded from gathering because camera NEE estimates direct illumination.

Spectral environment emission uses seven nonnegative PBRT illuminant RGB bases, normalized to unit white CIE luminance under the 360–830 nm sampler. This is RGB-to-spectrum approximation; HDR files do not contain measured spectral illumination.

Environment parameter changes update uniforms and reset accumulation without rebuilding the BVH. Map and quality changes replace textures. Cached decoded data restores textures after device loss. Disposal releases all GPU resources and terminates pending HDR imports.

## Validation scope (05.10.2026)

See the [current audit and roadmap](development-roadmap.md). Diagnostic functions and manual scenarios below do not imply a completed browser acceptance run.

### Automated unit tests

- `npm test`: Radiance decoding, orientation, corrupt RLE/size checks, bundled assets, PDF normalization, spherical mip energy including irregular sizes, spectral normalization, and open-scene visibility.
### Available GPU diagnostic functions

`src/debug/verify-environment.ts` provides independent GPU Lambertian energy acceptance (MIS / Light only / BSDF only), texture CDF/PDF comparison, and CPU/GPU spectral comparison. Dedicated automated browser coverage is planned; this module's presence does not mean it passed in this audit.

### Manual browser checks

Use the connected browser for scene controls, backgrounds, presets/uploads, PT/SPPM, RGB/spectral, budget rejection, settings links, and recovery. These scenarios were not repeated in this documentation package; future runs must record the adapter, settings and result.
