// eta is eta_t / eta_i. Normals face the incident direction.
fn dielectricFresnel(cosine: f32, eta: f32) -> f32 {
  if (eta == 1.0) { return 0.0; }
  let c = clamp(cosine, 0.0, 1.0);
  let sinSquared = max(0.0, 1.0 - c * c) / (eta * eta);
  if (sinSquared >= 1.0) { return 1.0; }
  let ct = sqrt(1.0 - sinSquared);
  let parallel = (eta * c - ct) / (eta * c + ct);
  let perpendicular = (c - eta * ct) / (c + eta * ct);
  return 0.5 * (parallel * parallel + perpendicular * perpendicular);
}
struct DielectricSample { direction: vec3f, weight: f32, transmitted: u32 }
fn sampleDielectric(direction: vec3f, normal: vec3f, eta: f32, random: f32, importance: bool) -> DielectricSample {
  let cosine = clamp(dot(-direction, normal), 0.0, 1.0);
  let fresnel = dielectricFresnel(cosine, eta);
  if (random < fresnel || fresnel >= 1.0) {
    return DielectricSample(normalize(reflect(direction, normal)), 1.0, 0u);
  }
  let ct = sqrt(max(0.0, 1.0 - (1.0 - cosine * cosine) / (eta * eta)));
  let wi = normalize(direction / eta + (cosine / eta - ct) * normal);
  return DielectricSample(wi, select(1.0 / (eta * eta), 1.0, importance), 1u);
}

// Adjoint correction for importance transport. Radiance uses the shading
// frame directly; coincident normals make both modes identical.
fn shadingNormalWeight(wo: vec3f, wi: vec3f, ng: vec3f, ns: vec3f, importance: bool) -> f32 {
  if (!importance) { return 1.0; }
  let denominator = abs(dot(wo, ng) * dot(wi, ns));
  if (denominator == 0.0) { return 0.0; }
  return abs(dot(wo, ns) * dot(wi, ng)) / denominator;
}

fn sampleDielectricSurface(direction: vec3f, ng: vec3f, ns: vec3f, eta: f32, random: f32, importance: bool) -> DielectricSample {
  if (dot(-direction, ns) <= 0.0) { return DielectricSample(vec3f(0), 0.0, 0u); }
  var event = sampleDielectric(direction, ns, eta, random, importance);
  // The shading frame may suggest an event on the wrong geometric side.
  // Such samples have zero BSDF; never reinterpret them as a medium transition.
  let sameSide = dot(event.direction, ng) > 0.0;
  if (sameSide == (event.transmitted != 0u)) { event.weight = 0.0; }
  else { event.weight *= shadingNormalWeight(-direction, event.direction, ng, ns, importance); }
  return event;
}
