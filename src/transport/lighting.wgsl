const PI: f32 = 3.141592653589793;
@group(0) @binding(5) var<storage, read> materials: array<Material>;
@group(0) @binding(6) var<storage, read> lights: array<LightTriangle>;
fn powerHeuristic(a: f32, b: f32) -> f32 {
  // Divide before squaring to avoid overflow for very large solid-angle PDFs.
  let scale = max(a, b);
  if (scale <= 0.0) { return 0.0; }
  let x = a / scale; let y = b / scale;
  return x * x / (x * x + y * y);
}
fn cosineDirection(normal: vec3f, u: vec2f) -> vec3f {
  let r = sqrt(u.x); let phi = 2.0 * PI * u.y;
  let helper = select(vec3f(0, 0, 1), vec3f(0, 1, 0), abs(normal.z) > 0.9);
  let tangent = normalize(cross(helper, normal)); let bitangent = cross(normal, tangent);
  return normalize(tangent * r * cos(phi) + bitangent * r * sin(phi) + normal * sqrt(max(0.0, 1.0 - u.x)));
}
struct LightSample { position: vec3f, pdfArea: f32, normal: vec3f, padding: f32, emission: vec3f, triangleId: u32 }
fn sampleLightAtWavelength(choice: f32, u: vec2f, lightCount: u32, wavelength: f32) -> LightSample {
  var low=0u; var high=lightCount;
  while(low<high) {let mid=low+(high-low)/2u;if(choice<lights[mid].cdf) {high=mid;} else {low=mid+1u;}}
  let index=min(low,lightCount-1u);
  let light = lights[index];
  let root = sqrt(u.x); let a = 1.0 - root; let b = root * (1.0 - u.y); let c = root * u.y;
  let normal = normalize(cross(light.b - light.a, light.c - light.a));
  let position=a * light.a + b * light.b + c * light.c;
  return LightSample(position, light.probability / light.area, normal, 0.0, surfaceEmission(materials[light.material],position,wavelength), light.triangleId);
}
fn lightPdf(previous: vec3f, position: vec3f, triangleId: u32, lightCount: u32) -> f32 {
  // Keep one return after the search; divergent per-emitter early returns failed
  // the numeric PDF acceptance on the target Intel UHD adapter.
  let delta = position - previous; let distanceSquared = dot(delta, delta);
  var pdf = 0.0;
  var low=0u;var high=lightCount;
  while(low<high) {let mid=low+(high-low)/2u;if(lights[mid].triangleId<triangleId) {low=mid+1u;} else {high=mid;}}
  if(low<lightCount) {
    let light = lights[low];
    if (light.triangleId == triangleId && distanceSquared > 0.0) {
      let normal = normalize(cross(light.b - light.a, light.c - light.a));
      let cosine = dot(normal, -normalize(delta));
      if (cosine > 0.0) { pdf = light.probability / light.area * distanceSquared / cosine; }
    }
  }
  return pdf;
}
fn rouletteWeight(beta: vec3f, etaScale: f32, random: f32) -> vec3f {
  let survival = min(0.95, max(beta.x, max(beta.y, beta.z)) * etaScale);
  if (survival <= 0.0 || random >= survival) { return vec3f(0); }
  return beta / survival;
}
