@group(0) @binding(9) var<storage, read> spectra: array<f32>;
const CIE_Y_INTEGRAL: f32 = 106.856895;
struct WavelengthSample { wavelength: f32, pdf: f32 }
fn sampleWavelength(u: f32) -> WavelengthSample {
  return WavelengthSample(360.0 + 470.0 * u, 1.0 / 470.0);
}
fn spectrumAt(offset: u32, wavelength: f32) -> f32 {
  let position = clamp(wavelength - 360.0, 0.0, 470.0);
  let index = min(u32(position), 469u);
  return mix(spectra[offset + index], spectra[offset + index + 1u], position - f32(index));
}
fn cieXyz(wavelength: f32) -> vec3f {
  return vec3f(spectrumAt(0u,wavelength), spectrumAt(471u,wavelength), spectrumAt(942u,wavelength));
}
fn spectralColor(rgb: vec3f, offset: u32, wavelength: f32) -> vec3f {
  if (wavelength == 0.0) { return rgb; }
  return vec3f(spectrumAt(offset,wavelength));
}
fn nbk7Ior(wavelengthNm: f32) -> f32 {
  // Manufacturer coefficients use micrometers; scene distances remain meters.
  let l2 = (wavelengthNm * 0.001) * (wavelengthNm * 0.001);
  return sqrt(1.0 + 1.03961212*l2/(l2-0.00600069867) + 0.231792344*l2/(l2-0.0200179144) + 1.01046945*l2/(l2-103.560653));
}
fn materialIor(material: Material, wavelength: f32) -> f32 {
  if (wavelength == 0.0 || material.iorModel == 0u) { return material.ior; }
  return nbk7Ior(wavelength);
}
