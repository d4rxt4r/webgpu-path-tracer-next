# Environment assets

Original 4K Radiance HDR panoramas downloaded from Poly Haven. No tone mapping or baking is applied to the source files. The application downsamples them in linear HDR at runtime.

`venice_sunset.hdr` uses lossless RGBE RLE re-encoding because GitHub push protection mistook a byte sequence in the original compressed stream for a token. The header and every RGBE channel value are unchanged. SHA-256 of the decoded scanline channel data: `32c66d6c85aa69b690c8e474a9b5d473ee1fd99402011bfae66bdcb2265fb6bf`.

| File | Author | Source |
| --- | --- | --- |
| studio_small_09.hdr | Sergej Majboroda | https://polyhaven.com/a/studio_small_09 |
| kiara_1_dawn.hdr | Greg Zaal | https://polyhaven.com/a/kiara_1_dawn |
| venice_sunset.hdr | Greg Zaal | https://polyhaven.com/a/venice_sunset |

All three panoramas are CC0: https://polyhaven.com/license . Download URLs: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/{name}_4k.hdr`.

The seven RGB illuminant spectral bases in `src/transport/illuminant-bases.json` come from https://github.com/mmp/pbrt-v3/blob/master/src/core/spectrum.cpp . See PBRT-LICENSE.txt for the BSD license. RGB-to-spectrum conversion is an approximation, not measured spectral HDR data. Negative basis entries are clamped to zero. The PBRT illuminant scale 0.86445 is calibrated so white integrates to unit CIE luminance under the renderer's 360..830 nm wavelength sampler.
