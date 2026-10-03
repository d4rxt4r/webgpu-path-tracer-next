struct PathResult { radiance: vec3f, error: u32 }
// Dimensions 0..1 camera, 2 reserved for wavelength, seven fixed slots per bounce:
// light choice/UV (3), BSDF UV (2), BSDF event (1), roulette (1).
fn tracePath(initial: Ray, sampleIndex: u32, pixel: u32, seed: u32, maxDepth: u32, strategy: u32, lightCount: u32) -> PathResult {
  var ray = initial; var beta = vec3f(1.0); var radiance = vec3f(0.0);
  var previousPosition = initial.origin; var previousPdf = 0.0;
  var previousDelta = true; var etaScale = 1.0;
  var medium = NO_HIT;
  for (var depth = 0u; depth <= maxDepth; depth++) {
    let hit = closestHit(ray);
    if (hit.error != 0u) { return PathResult(vec3f(0), hit.error); }
    if (hit.id == NO_HIT) {
      if (medium != NO_HIT) { return PathResult(vec3f(0), 4u); }
      break;
    }
    let triangle = triangles[hit.triangle];
    if (triangle.material >= arrayLength(&materials)) { return PathResult(vec3f(0), 1u); }
    let material = materials[triangle.material];
    let ng = geometricNormal(triangle);
    let position = ray.origin + hit.t * ray.direction;
    // A camera inside a solid starts in that medium. Only disjoint solids are supported.
    if (depth == 0u && material.kind == 2u && dot(ng, ray.direction) > 0.0) { medium = hit.triangle; }
    if (medium != NO_HIT) {
      beta *= exp(-materials[triangles[medium].material].absorption * length(position - previousPosition));
    }
    if (material.kind == 1u) {
      if (dot(ng, -ray.direction) > 0.0) {
        var weight = 1.0;
        if (depth > 0u && !previousDelta) {
          if (strategy == 0u) { weight = powerHeuristic(previousPdf, lightPdf(previousPosition, position, triangle.id, lightCount)); }
          else if (strategy == 1u) { weight = 0.0; }
        }
        radiance += beta * material.color * weight;
      }
      break;
    }
    if (depth == maxDepth) { break; }
    let n = select(ng, -ng, dot(ng, -ray.direction) < 0.0);
    let dimension = 3u + depth * 7u;
    if (material.kind == 2u) {
      let entering = dot(ng, ray.direction) < 0.0;
      if ((entering && medium != NO_HIT) || (!entering && (medium == NO_HIT || triangles[medium].surface != triangle.surface))) {
        return PathResult(vec3f(0), 4u);
      }
      let eta = select(1.0 / material.ior, material.ior, entering);
      let ns = shadingNormal(triangle, hit);
      let orientedShading = select(-ns, ns, entering);
      let event = sampleDielectricSurface(ray.direction, n, orientedShading, eta, sample1D(sampleIndex, dimension + 5u, pixel, seed), false);
      if (event.weight == 0.0) { break; }
      beta *= event.weight;
      if (event.transmitted != 0u) {
        medium = select(NO_HIT, hit.triangle, entering);
        etaScale *= eta * eta;
      }
      previousPosition = position; previousPdf = 0.0; previousDelta = true;
      if (depth >= 4u) {
        beta = rouletteWeight(beta, etaScale, sample1D(sampleIndex, dimension + 6u, pixel, seed));
        if (all(beta == vec3f(0))) { break; }
      }
      ray = Ray(offsetOrigin(position, ng, event.direction), 0.0, event.direction, 1e20);
      continue;
    }
    if (strategy != 2u && lightCount > 0u) {
      let light = sampleLight(sample1D(sampleIndex, dimension, pixel, seed), vec2f(sample1D(sampleIndex, dimension + 1u, pixel, seed), sample1D(sampleIndex, dimension + 2u, pixel, seed)), lightCount);
      let delta = light.position - position; let distanceSquared = dot(delta, delta);
      let wi = normalize(delta); let cosine = max(0.0, dot(n, wi)); let lightCosine = dot(light.normal, -wi);
      if (cosine > 0.0 && lightCosine > 0.0 && distanceSquared > 0.0) {
        let pdf = light.pdfArea * distanceSquared / lightCosine;
        // Offset both endpoints. Glass is not treated as an opacity shadow pass.
        let origin = offsetOrigin(position, ng, wi);
        let lightEndpoint = offsetOrigin(light.position, light.normal, -wi);
        let segment = lightEndpoint - origin; let distance = length(segment);
        let shadow = anyHit(Ray(origin, 0.0, segment / distance, distance * (1.0 - 1e-6)));
        if (shadow.error != 0u) { return PathResult(vec3f(0), shadow.error); }
        if (shadow.id == NO_HIT) {
          let weight = select(1.0, powerHeuristic(pdf, cosine / PI), strategy == 0u);
          radiance += beta * material.color / PI * light.emission * cosine * weight / pdf;
        }
      }
    }
    let wi = cosineDirection(n, vec2f(sample1D(sampleIndex, dimension + 3u, pixel, seed), sample1D(sampleIndex, dimension + 4u, pixel, seed)));
    previousPosition = position; previousPdf = max(0.0, dot(n, wi)) / PI;
    previousDelta = false;
    beta *= material.color;
    // After the fifth scattering, survival is compensated in throughput.
    if (depth >= 4u) {
      beta = rouletteWeight(beta, etaScale, sample1D(sampleIndex, dimension + 6u, pixel, seed));
      if (all(beta == vec3f(0))) { break; }
    }
    ray = Ray(offsetOrigin(position, ng, wi), 0.0, wi, 1e20);
  }
  if (!all(radiance >= vec3f(0.0)) || !all(radiance < vec3f(FAR))) { return PathResult(vec3f(0), 3u); }
  return PathResult(radiance, 0u);
}
