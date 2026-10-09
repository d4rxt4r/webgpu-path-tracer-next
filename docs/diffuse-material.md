# Diffuse color and roughness

The selected object's base color is edited in sRGB with a palette and synchronized integer RGB channels. Reflectance is linear base color times albedo (0–1). Defaults are white, albedo 0.65 and roughness zero, preserving old links and Lambert rendering. Channel middle resets use 255, albedo 0.65 and roughness zero. Hidden groups survive switching, URL reload and JSON export; the palette is authoritative when restoring links.

`MaterialDescription` diffuse entries accept optional `roughness` in 0–1; omission means zero. Reflectance and spectrum already include albedo. Neutral colors use constant spectra; other colors use the existing bounded reconstruction, multiplied by albedo. Walls and other materials retain their existing models.

Nonzero roughness uses reciprocal Oren-Nayar, sigma = roughness * pi/2. Starting from [PBRT's approximation](https://www.pbr-book.org/3ed-2018/Reflection_Models/Microfacet_Models#OrenndashNayarDiffuseReflection), A = 1 - sigma²/(2(sigma²+0.33)), B = 0.45 sigma²/(sigma²+0.09). Both coefficients are divided by max(1, A+B/2). The angular term is bounded by tan(theta_i); its cosine-weighted hemispherical integral, including positive azimuth cosine, is at most 1/2. This direction-independent normalization therefore limits reflected energy without breaking reciprocity. It is a normalized variant of the PBRT approximation.

Kind 10 stores roughness and normalized A/B in the existing material parameters. Cosine sampling/PDF and the original Sobol slots are retained. PT direct lighting/MIS/continuation and SPPM camera/photon/gather use the same BRDF evaluation as other opaque materials. Zero roughness retains the legacy kind 0 and unchanged material buffer bytes. Prepared transport keys include the coefficient implementation.

PBRT v4 export supports colored Lambert with an explicit reflectance spectrum. Nonzero roughness is rejected with an explanation, since the existing exporter cannot reproduce this normalized model exactly. No textures, coating or surface wear are introduced.

Validation evidence is recorded in `docs/validation/diffuse-material/` separately from the previous opaque-material results.
