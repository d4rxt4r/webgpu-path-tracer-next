struct PathResult { radiance: vec3f, error: u32, interactions: u32 }
// Dimensions 0..1 camera, 2 wavelength, seven fixed slots per bounce:
// light choice/UV (3), BSDF UV (2), BSDF event (1), roulette (1).
fn tracePathAtWavelength(initial: Ray, sampleIndex: u32, pixel: u32, seed: u32, maxDepth: u32, strategy: u32, lightCount: u32, wavelength: f32) -> PathResult {
  var interactions = 0u;
  var ray = initial; var beta = vec3f(1.0); var radiance = vec3f(0.0);
  var previousPosition = initial.origin; var previousPdf = 0.0;
  var previousDelta = true; var etaScale = 1.0;
  var medium = NO_HIT;
  for (var depth = 0u; depth <= maxDepth; depth++) {
    let hit = closestHit(ray);
    if (hit.error != 0u) { return PathResult(vec3f(0), hit.error, interactions); }
    if (hit.id == NO_HIT) {
      if (medium != NO_HIT) { return PathResult(vec3f(0), 4u, interactions); }
      break;
    }
    interactions = depth + 1u;
    let triangle = triangles[hit.triangle];
    if (triangle.material >= arrayLength(&materials)) { return PathResult(vec3f(0), 1u, interactions); }
    let material = materials[triangle.material];
    let ng = geometricNormal(triangle);
    let position = surfacePosition(triangle,hit);
    let color = surfaceColor(material, position, wavelength);
    // A camera inside a solid starts in that medium. Only disjoint solids are supported.
    if (depth == 0u && material.kind == 2u && dot(ng, ray.direction) > 0.0) { medium = hit.triangle; }
    if (medium != NO_HIT) {
      let inside = materials[triangles[medium].material];
      beta *= exp(-spectralColor(inside.absorption, inside.absorptionOffset, wavelength) * length(position - previousPosition));
    }
    if (material.kind == 1u || material.kind == 4u) {
      if (dot(ng, -ray.direction) > 0.0) {
        var weight = 1.0;
        if (depth > 0u && !previousDelta) {
          if (strategy == 0u) { weight = powerHeuristic(previousPdf, lightPdf(previousPosition, position, triangle.id, lightCount)); }
          else if (strategy == 1u) { weight = 0.0; }
        }
        radiance += beta * surfaceEmission(material, position, wavelength) * weight;
      }
      if (material.kind == 1u) { break; }
    }
    if (depth == maxDepth) { break; }
    let n = select(ng, -ng, dot(ng, -ray.direction) < 0.0);
    let dimension = 3u + depth * 7u;
    if (material.kind == 2u) {
      let entering = dot(ng, ray.direction) < 0.0;
      if ((entering && medium != NO_HIT) || (!entering && (medium == NO_HIT || triangles[medium].surface != triangle.surface))) {
        return PathResult(vec3f(0), 4u, interactions);
      }
      let ior = materialIor(material, wavelength);
      let eta = select(1.0 / ior, ior, entering);
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
      ray = Ray(offsetSurface(triangle,hit,event.direction), 0.0, event.direction, 1e20);
      continue;
    }
    let coating=coatingProbability(material);
    if (strategy != 2u && lightCount > 0u) {
      let light = sampleLightAtWavelength(sample1D(sampleIndex, dimension, pixel, seed), vec2f(sample1D(sampleIndex, dimension + 1u, pixel, seed), sample1D(sampleIndex, dimension + 2u, pixel, seed)), lightCount, wavelength);
      let delta = light.position - position; let distanceSquared = dot(delta, delta);
      let wi = normalize(delta); let cosine = max(0.0, dot(n, wi)); let lightCosine = dot(light.normal, -wi);
      if (cosine > 0.0 && lightCosine > 0.0 && distanceSquared > 0.0) {
        let pdf = light.pdfArea * distanceSquared / lightCosine;
        // Offset both endpoints. Glass is not treated as an opacity shadow pass.
        let origin = offsetSurface(triangle,hit,wi);
        let lightEndpoint = offsetOrigin(light.position, light.normal, -wi);
        let segment = lightEndpoint - origin; let distance = length(segment);
        let shadow = anyHit(Ray(origin, 0.0, segment / distance, distance * (1.0 - 1e-6)));
        if (shadow.error != 0u) { return PathResult(vec3f(0), shadow.error, interactions); }
        if (shadow.id == NO_HIT) {
          let weight = select(1.0, powerHeuristic(pdf, (1.0-coating)*cosine / PI), strategy == 0u);
          radiance += beta * (1.0-coating) * color / PI * light.emission * cosine * weight / pdf;
        }
      }
    }
    if (sample1D(sampleIndex,dimension+5u,pixel,seed)<coating) {
      let ns=shadingNormal(triangle,hit);
      let oriented=select(ns,-ns,dot(ns,n)<0.0);
      let wi=coatingDirection(ray.direction,n,oriented);
      previousPosition=position;previousPdf=0.0;previousDelta=true;
      if(depth>=4u) {beta=rouletteWeight(beta,etaScale,sample1D(sampleIndex,dimension+6u,pixel,seed));if(all(beta==vec3f(0))) {break;}}
      ray=Ray(offsetSurface(triangle,hit,wi),0.0,wi,1e20);
      continue;
    }
    let wi = cosineDirection(n, vec2f(sample1D(sampleIndex, dimension + 3u, pixel, seed), sample1D(sampleIndex, dimension + 4u, pixel, seed)));
    previousPosition = position; previousPdf = (1.0-coating)*max(0.0, dot(n, wi)) / PI;
    previousDelta = false;
    beta *= color;
    // After the fifth scattering, survival is compensated in throughput.
    if (depth >= 4u) {
      beta = rouletteWeight(beta, etaScale, sample1D(sampleIndex, dimension + 6u, pixel, seed));
      if (all(beta == vec3f(0))) { break; }
    }
    ray = Ray(offsetSurface(triangle,hit,wi), 0.0, wi, 1e20);
  }
  if (!all(radiance >= vec3f(0.0)) || !all(radiance < vec3f(FAR))) { return PathResult(vec3f(0), 3u, interactions); }
  return PathResult(radiance, 0u, interactions);
}

fn tracePath(initial: Ray, sampleIndex: u32, pixel: u32, seed: u32, maxDepth: u32, strategy: u32, lightCount: u32) -> PathResult {
  return tracePathAtWavelength(initial,sampleIndex,pixel,seed,maxDepth,strategy,lightCount,0.0);
}
fn traceSpectralPath(initial: Ray, sampleIndex: u32, pixel: u32, seed: u32, maxDepth: u32, strategy: u32, lightCount: u32) -> PathResult {
  let sample = sampleWavelength(sample1D(sampleIndex,2u,pixel,seed));
  let value = tracePathAtWavelength(initial,sampleIndex,pixel,seed,maxDepth,strategy,lightCount,sample.wavelength);
  let xyz = cieXyz(sample.wavelength) * value.radiance.x / (sample.pdf * CIE_Y_INTEGRAL);
  return PathResult(xyz,value.error,value.interactions);
}
