# Materials

All editor groups retain settings when hidden, switching types, restoring links and exporting JSON. UI colors are sRGB, converted to linear values for transport. RGB reconstruction is an approximation, not a measured spectrum. Numeric resets use stored defaults.

## Dielectric and procedural materials

Dielectrics support smooth/rough GGX reflection/refraction, IOR, absorption, artistic Cauchy/Abbe dispersion and Auto/Volume/Thin modes. Measured N-BK7 exists in diagnostic scenes. Thin glass has no volumetric absorption/refraction or lens caustics.

Independent scratches, scuffs and fingerprints each have enable flags, strength, scale and seed, plus detailed controls. Disabled effects retain values and skip procedural evaluation. Model-relative or scene-metre scale supports nonuniform transforms/shear, with patterns attached to the object. Rastagotchi defaults to medium wear; other models start clean. Legacy settings migrate to surfaceWear version 2. Wear affects only dielectrics and does not change geometry/silhouette. PT/SPPM/denoiser guides share active-effect variants.

Procedural marble and lava remain supported; lava includes emission. No UV texture/MTL support is implied.

## Diffuse


The selected object's base color is edited in sRGB with a palette and synchronized integer RGB channels. Reflectance is linear base color times albedo (0–1). Defaults are white, albedo 0.65 and roughness zero, preserving old links and Lambert rendering. Channel middle resets use 255, albedo 0.65 and roughness zero. Hidden groups survive switching, URL reload and JSON export; the palette is authoritative when restoring links.

`MaterialDescription` diffuse entries accept optional `roughness` in 0–1; omission means zero. Reflectance and spectrum already include albedo. Neutral colors use constant spectra; other colors use the existing bounded reconstruction, multiplied by albedo. Walls and other materials retain their existing models.

Nonzero roughness uses reciprocal Oren-Nayar, sigma = roughness * pi/2. Starting from [PBRT's approximation](https://www.pbr-book.org/3ed-2018/Reflection_Models/Microfacet_Models#OrenndashNayarDiffuseReflection), A = 1 - sigma²/(2(sigma²+0.33)), B = 0.45 sigma²/(sigma²+0.09). Both coefficients are divided by max(1, A+B/2). The angular term is bounded by tan(theta_i); its cosine-weighted hemispherical integral, including positive azimuth cosine, is at most 1/2. This direction-independent normalization therefore limits reflected energy without breaking reciprocity. It is a normalized variant of the PBRT approximation.

Kind 10 stores roughness and normalized A/B in the existing material parameters. Cosine sampling/PDF and the original Sobol slots are retained. PT direct lighting/MIS/continuation and SPPM camera/photon/gather use the same BRDF evaluation as other opaque materials. Zero roughness retains the legacy kind 0 and unchanged material buffer bytes. Prepared transport keys include the coefficient implementation.

PBRT v4 export supports colored Lambert with an explicit reflectance spectrum. Nonzero roughness is rejected with an explanation, since the existing exporter cannot reproduce this normalized model exactly. No textures, coating or surface wear are introduced.


## Metal, plastic and emission

Metal defaults to aluminum with roughness 0.2. Custom metal is an artistic Schlick-Fresnel approximation, not measured conductor data.


The material editor preserves each group when switching types. Metal presets are aluminum, gold, copper and silver (complex Fresnel, isotropic GGX); Custom uses a linear RGB F0 with Schlick Fresnel and the existing bounded nonnegative spectral reconstruction. Its first color comes from the previous preset at normal incidence. The palette is authoritative when restoring links; RGB channels synchronize to it. The initial channel defaults are retained independently in `metal-color-default`, including in URLs and exported JSON. A restored initialized custom color is never replaced by a preset.

Plastic uses Ashikhmin-Shirley FresnelBlend with GGX and an IOR-derived neutral F0. Default color is #4f87c5, roughness 0.2 and IOR 1.5. A smooth surface retains a discrete mirror event alongside the diffuse component.

Reflecting emitters have separate diffuse reflectance and emission spectra. Defaults are #808080, white emission and power 10. The convenient power slider spans 0–40; the numeric input retains larger accepted values. Packing rejects nonfinite spectra and overflowing RGB/spectral photon flux before replacing the current scene. At power zero the base still reflects and the triangles are excluded from light sampling. Pure legacy emitters retain their terminating behavior. Emission uses outward geometric normals and the environment illuminant reconstruction.

PT, spectral PT, SPPM camera/photon transport and precise paths share `opaque.wgsl`. Rough opaque points gather the evaluated BRDF; mirror events continue. Direct photon hits are excluded because camera NEE estimates them. The original seven Sobol slots per bounce remain unchanged. The existing material buffer and its two spectral slots accommodate the new kinds (6 physical metal, 7 custom metal, 8 plastic, 9 reflecting emitter); geometry, diagnostics and denoiser guides retain their layouts. Prepared transport keys include conductor data and packing dependencies.

PBRT export writes conductor eta/k tables and reflecting emitter bases. It rejects custom Schlick metal and FresnelBlend plastic with an explicit explanation. Surface wear remains limited to the existing dielectric.

## Sources

- [Pinned PBRT tables and license](licenses/conductor-data.md).
- [Conductor BRDF](https://www.pbr-book.org/4ed/Reflection_Models/Conductor_BRDF).
- [Ashikhmin-Shirley FresnelBlend](https://www.pbr-book.org/3ed-2018/Reflection_Models/Fresnel_Incidence_Effects).


## PBRT export boundaries

Physical conductor presets and reflecting emitter bases are supported. Colored Lambert export includes its reflectance spectrum. Custom Schlick metal, plastic and nonzero normalized diffuse roughness are explicitly rejected because the exporter cannot reproduce these models exactly. Disable dielectric surface wear for reference export. Circular camera optics are supported; active aperture polygons are rejected.

See [verification](verification.md) for recorded checks and reproduction commands.
