struct PathResult { radiance: vec3f, error: u32, interactions: u32 }
// Dimensions 0..1 camera, 2 wavelength, seven fixed slots per bounce:
// light choice/UV (3), BSDF UV (2), BSDF event (1), roulette (1).
fn tracePathWithMedia(initial: Ray, sampleIndex: u32, pixel: u32, seed: u32, maxDepth: u32, strategy: u32, lightCount: u32, wavelength: f32, initialMedia: MediumSet) -> PathResult {
  var interactions = 0u;
  var ray = initial; var beta = vec3f(1.0); var radiance = vec3f(0.0);
  var originLow=vec3f(0);
  var previousPosition = initial.origin; var previousPdf = 0.0;
  var lightPosition=initial.origin;
  var previousDelta = true; var etaScale = 1.0;
  var media=initialMedia; var medium=activeMedium(media);
  if(media.error!=0u) {return PathResult(vec3f(0),4u,0u);}
  var crossings=0u; var spawnedTriangle=NO_HIT;
  for (var depth = 0u; depth <= maxDepth;) {
    let hit = closestHitWithOrigin(ray,originLow);
    if (hit.error != 0u) { return PathResult(vec3f(0), hit.error, interactions); }
    if (hit.id == NO_HIT) {
      if (medium != NO_HIT) { return PathResult(vec3f(0), 4u, interactions); }
      var weight=1.0;
      if(depth>0u && !previousDelta) {
        if(strategy==0u) {weight=powerHeuristic(previousPdf,environmentPdf(ray.direction)*environment.sampling.y);}
        else if(strategy==1u) {weight=0.0;}
      }
      radiance+=beta*environmentRadiance(ray.direction,wavelength,depth==0u)*weight;
      break;
    }
    crossings++;
    if(crossings>arrayLength(&triangles)+maxDepth+1u) {return PathResult(vec3f(0),4u,interactions);}
    // The planar surface that spawned this straight ray cannot be hit again.
    // Preserve other nearby boundaries by advancing only past the residual hit.
    if(hit.triangle==spawnedTriangle) {
      let distance=max(0.0,hit.t+abs(bitcast<f32>(hit.padding)));
      ray.tMin=max(bitcast<f32>(0x00800000u),bitcast<f32>(bitcast<u32>(distance)+1u));continue;
    }
    interactions = depth + 1u;
    let triangle = triangles[hit.triangle];
    if (triangle.material >= arrayLength(&materials)) { return PathResult(vec3f(0), 1u, interactions); }
    let material = materials[triangle.material];
    if(!PRECISE_TRANSPORT && medium!=NO_HIT && material.kind!=2u) {return PathResult(vec3f(0),5u,interactions);}
    let ng = geometricNormal(triangle);
    let position = surfacePosition(triangle,hit);
    let color = surfaceColor(material, position, wavelength);

    if (medium != NO_HIT) {
      let inside = materials[triangles[medium].material];
      beta *= exp(-spectralColor(inside.absorption, inside.absorptionOffset, wavelength) * length(position - previousPosition));
    }
    if (material.kind == 1u || material.kind == 4u) {
      if (dot(ng, -ray.direction) > 0.0) {
        var weight = 1.0;
        if (depth > 0u && !previousDelta) {
          if (strategy == 0u) { weight = powerHeuristic(previousPdf, lightPdf(lightPosition, position, triangle.id, lightCount)*(1.0-environment.sampling.y)); }
          else if (strategy == 1u) { weight = 0.0; }
        }
        radiance += beta * surfaceEmission(material, position, wavelength) * weight;
      }
      if (material.kind == 1u) { break; }
    }
    if (depth == maxDepth && material.kind != 2u) { break; }
    let n = select(ng, -ng, dot(ng, -ray.direction) < 0.0);
    let dimension = 3u + depth * 7u;
    if (material.kind == 5u) {
      if(!PRECISE_TRANSPORT && needsPreciseOrigin(ray,triangle,hit)) {return PathResult(vec3f(0),5u,interactions);}
      let ns0=shadingNormal(triangle,hit);let ns=select(ns0,-ns0,dot(ns0,n)<0.0);
      let eta=materialIor(material,wavelength);
      if(material.textureParams.x>0.0 && strategy!=2u && (lightCount>0u || environment.sampling.y>0.0)) {
        let light=sampleSceneLight(sample1D(sampleIndex,dimension,pixel,seed),vec2f(sample1D(sampleIndex,dimension+1u,pixel,seed),sample1D(sampleIndex,dimension+2u,pixel,seed)),lightCount,wavelength);
        let direct=roughDirect(material,position,triangle,hit,-ray.direction,n,ns,eta,wavelength,light,strategy);
        if(direct.error!=0u) {return PathResult(vec3f(0),direct.error,interactions);}
        radiance+=beta*direct.radiance;
      }
      let event=sampleEditedDielectric(material,ray.direction,n,ns,eta,wavelength,vec2f(sample1D(sampleIndex,dimension+3u,pixel,seed),sample1D(sampleIndex,dimension+4u,pixel,seed)),sample1D(sampleIndex,dimension+5u,pixel,seed),false);
      if(all(event.weight==vec3f(0))) {break;} beta*=event.weight;
      previousPosition=position;lightPosition=position;previousPdf=event.pdf;previousDelta=material.textureParams.x==0.0;
      if (depth >= 4u) {
        beta = rouletteWeight(beta, etaScale, sample1D(sampleIndex, dimension + 6u, pixel, seed));
        if (all(beta == vec3f(0))) { break; }
      }
      let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
      ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;spawnedTriangle=hit.triangle;
      depth++;crossings=0u;continue;
    }
    if (material.kind == 2u) {
      if(!PRECISE_TRANSPORT && needsPreciseOrigin(ray,triangle,hit)) {return PathResult(vec3f(0),5u,interactions);}
      let entering = dot(ng, ray.direction) < 0.0;
      let nextMedia=changeMediumAtSurface(media,ray,originLow,hit);
      if(nextMedia.error!=0u) {return PathResult(vec3f(0),4u,interactions);}
      let eta=mediumIor(nextMedia,wavelength)/mediumIor(media,wavelength);
      if(eta==1.0) {
        media=nextMedia;medium=activeMedium(media);previousPosition=position;
        let event=DielectricSample(ray.direction,1.0,1u);
        let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
        ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;spawnedTriangle=hit.triangle;
        continue;
      }
      if(depth==maxDepth) {break;}
      let ns = shadingNormal(triangle, hit);
      let orientedShading = select(-ns, ns, entering);
      if(material.textureParams.x>0.0 && strategy!=2u && (lightCount>0u || environment.sampling.y>0.0)) {
        let light=sampleSceneLight(sample1D(sampleIndex,dimension,pixel,seed),vec2f(sample1D(sampleIndex,dimension+1u,pixel,seed),sample1D(sampleIndex,dimension+2u,pixel,seed)),lightCount,wavelength);
        let direct=roughDirect(material,position,triangle,hit,-ray.direction,n,orientedShading,eta,wavelength,light,strategy);
        if(direct.error!=0u) {return PathResult(vec3f(0),direct.error,interactions);}
        radiance+=beta*direct.radiance;
      }
      let event=sampleEditedDielectric(material,ray.direction,n,orientedShading,eta,wavelength,vec2f(sample1D(sampleIndex,dimension+3u,pixel,seed),sample1D(sampleIndex,dimension+4u,pixel,seed)),sample1D(sampleIndex,dimension+5u,pixel,seed),false);
      if(all(event.weight==vec3f(0))) {break;} beta*=event.weight;
      if (event.transmitted != 0u) {
        media=nextMedia;medium=activeMedium(media);
        etaScale *= eta * eta;
      }
      previousPosition = position; lightPosition=position; previousPdf = event.pdf; previousDelta = material.textureParams.x==0.0;
      if (depth >= 4u) {
        beta = rouletteWeight(beta, etaScale, sample1D(sampleIndex, dimension + 6u, pixel, seed));
        if (all(beta == vec3f(0))) { break; }
      }
      let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
      ray = Ray(origin.position, 0.0, event.direction, 1e20);originLow=origin.residual;spawnedTriangle=hit.triangle;
      depth++;crossings=0u;continue;
    }
    let coating=coatingProbability(material);
    if (strategy != 2u && (lightCount > 0u || environment.sampling.y>0.0)) {
      let light = sampleSceneLight(sample1D(sampleIndex, dimension, pixel, seed), vec2f(sample1D(sampleIndex, dimension + 1u, pixel, seed), sample1D(sampleIndex, dimension + 2u, pixel, seed)), lightCount, wavelength);
      var wi:vec3f;var pdf:f32;var visible=true;var endpoint:vec3f;
      if(light.padding==1.0) {wi=light.position;pdf=light.pdfArea;}
      else {
        let delta=light.position-position;let d2=dot(delta,delta);wi=normalize(delta);let lc=dot(light.normal,-wi);
        visible=lc>0.0 && d2>0.0;pdf=light.pdfArea*d2/max(lc,1e-20);
        endpoint=offsetOrigin(light.position,light.normal,-wi);
      }
      let cosine=max(0.0,dot(n,wi));
      if(cosine>0.0 && visible && pdf>0.0) {
        let origin=offsetSurface(triangle,hit,wi);var shadowRay=Ray(origin,0.0,wi,1e20);
        if(light.padding==0.0) {let segment=endpoint-origin;let distance=length(segment);shadowRay=Ray(origin,0.0,segment/distance,distance*(1.0-1e-6));}
        let shadow=anyHit(shadowRay);
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
      previousPosition=position;lightPosition=position;previousPdf=0.0;previousDelta=true;
      if(depth>=4u) {beta=rouletteWeight(beta,etaScale,sample1D(sampleIndex,dimension+6u,pixel,seed));if(all(beta==vec3f(0))) {break;}}
      ray=Ray(offsetSurface(triangle,hit,wi),0.0,wi,1e20);originLow=vec3f(0);spawnedTriangle=hit.triangle;
      depth++;crossings=0u;continue;
    }
    let wi = cosineDirection(n, vec2f(sample1D(sampleIndex, dimension + 3u, pixel, seed), sample1D(sampleIndex, dimension + 4u, pixel, seed)));
    previousPosition = position; lightPosition=position; previousPdf = (1.0-coating)*max(0.0, dot(n, wi)) / PI;
    previousDelta = false;
    beta *= color;
    // After the fifth scattering, survival is compensated in throughput.
    if (depth >= 4u) {
      beta = rouletteWeight(beta, etaScale, sample1D(sampleIndex, dimension + 6u, pixel, seed));
      if (all(beta == vec3f(0))) { break; }
    }
    ray = Ray(offsetSurface(triangle,hit,wi), 0.0, wi, 1e20);originLow=vec3f(0);spawnedTriangle=hit.triangle;
    depth++;crossings=0u;
  }
  if (!all(radiance >= vec3f(0.0)) || !all(radiance < vec3f(FAR))) { return PathResult(vec3f(0), 3u, interactions); }
  return PathResult(radiance, 0u, interactions);
}

fn tracePathAtWavelength(initial: Ray, sampleIndex: u32, pixel: u32, seed: u32, maxDepth: u32, strategy: u32, lightCount: u32, wavelength: f32) -> PathResult {
  var state:MediumSet;
  return tracePathWithMedia(initial,sampleIndex,pixel,seed,maxDepth,strategy,lightCount,wavelength,state);
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
