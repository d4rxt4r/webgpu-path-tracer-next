@group(0) @binding(0) var outputImage: texture_storage_2d<rgba16float,write>;
@group(0) @binding(1) var<uniform> params: CameraParams;
@group(0) @binding(8) var<storage,read_write> accumulation: array<vec4f>;
@group(0) @binding(10) var<storage,read_write> points: array<SppmPoint>;
@group(0) @binding(11) var<uniform> sppm: SppmParams;
@group(0) @binding(21) var<storage,read_write> photons: array<Photon>;
@group(0) @binding(22) var<storage,read_write> heads: array<atomic<u32>>;
fn pointRadius(point: SppmPoint) -> f32 { return select(point.radius,sppm.initialRadius,point.iterations==0u); }
fn cellHash(cell: vec3i) -> u32 {
  return hash32((bitcast<u32>(cell.x)*73856093u) ^ (bitcast<u32>(cell.y)*19349663u) ^ (bitcast<u32>(cell.z)*83492791u)) & sppm.hashMask;
}
// One Owen-Sobol wavelength for the whole iteration, stratified in power-of-two blocks.
// Keep photon throughput unweighted; cameraPoint is converted to XYZ exactly once.
fn iterationWavelength() -> WavelengthSample {
  if(params.transportMode==0u) {return WavelengthSample(0.0,1.0);}
  return sampleWavelength(sample1D(params.frame,2u,0x7370706du,params.seed));
}
fn cameraPoint(initial: Ray, pixel: u32, wavelength: f32) -> SppmPoint {
  var point: SppmPoint; var ray=initial; var originLow=vec3f(0);var beta=vec3f(1); var etaScale=1.0;
  var media=cameraMedia(params);var medium=activeMedium(media); var previous=initial.origin;
  if(media.error!=0u) {reportTransportError(2u,1u,pixel,0u,NO_HIT,NO_HIT);return point;}
  var crossings=0u;
  for(var depth=0u;depth<=params.maxDepth;) {
    crossings++;
    if(crossings>arrayLength(&triangles)+params.maxDepth+1u) {reportTransportError(2u,1u,pixel,depth,NO_HIT,medium);break;}
    let hit=closestHitWithOrigin(ray,originLow);
    if(hit.error==5u && !PRECISE_TRANSPORT) {point.valid=2u;break;}
    if(hit.error!=0u) { reportTransportError(1u,1u,pixel,depth,hit.triangle,medium);break; }
    if(hit.id==NO_HIT) { if(medium!=NO_HIT) {if(!PRECISE_TRANSPORT) {point.valid=2u;break;} reportTransportError(2u,1u,pixel,depth,NO_HIT,medium);} break; }
    let triangle=triangles[hit.triangle];
    if(triangle.material>=arrayLength(&materials)) {reportTransportError(3u,1u,pixel,depth,hit.triangle,medium);break;}
    let material=materials[triangle.material];
    if(!PRECISE_TRANSPORT && medium!=NO_HIT && material.kind!=2u) {point.valid=2u;break;}
    let ng=geometricNormal(triangle); let position=surfacePosition(triangle,hit);
    let color=surfaceColor(material,position,wavelength);

    if(medium!=NO_HIT) {let inside=materials[triangles[medium].material];beta*=exp(-spectralColor(inside.absorption,inside.absorptionOffset,wavelength)*length(position-previous));}
    let n=select(ng,-ng,dot(ng,-ray.direction)<0.0);
    if(material.kind==1u||material.kind==4u) {if(dot(ng,-ray.direction)>0.0) {point.direct+=beta*surfaceEmission(material,position,wavelength);} if(material.kind==1u) {break;}}
    let dimension=3u+depth*7u;
    if(material.kind==0u||material.kind==3u||material.kind==4u) {
      if(sample1D(params.frame,dimension+5u,pixel,params.seed)<coatingProbability(material)) {
        if(depth==params.maxDepth) {break;}
        let ns=shadingNormal(triangle,hit);let oriented=select(ns,-ns,dot(ns,n)<0.0);
        let wi=coatingDirection(ray.direction,n,oriented);previous=position;
        if(depth>=4u) {beta=rouletteWeight(beta,etaScale,sample1D(params.frame,dimension+6u,pixel,params.seed));if(all(beta==vec3f(0))) {break;}}
        ray=Ray(offsetSurface(triangle,hit,wi),0.0,wi,1e20);originLow=vec3f(0);depth++;crossings=0u;continue;
      }
      point.position=position; point.surface=triangle.surface; point.normal=n;
      point.weight=beta*color/PI; point.valid=u32(any(point.weight>vec3f(0)));
      if(params.lightCount>0u) {
        let light=sampleLightAtWavelength(sample1D(params.frame,dimension,pixel,params.seed),vec2f(sample1D(params.frame,dimension+1u,pixel,params.seed),sample1D(params.frame,dimension+2u,pixel,params.seed)),params.lightCount,wavelength);
        let delta=light.position-position; let d2=dot(delta,delta); let wi=normalize(delta);
        let cosine=max(0.0,dot(n,wi)); let lightCosine=dot(light.normal,-wi);
        if(d2>0.0&&cosine>0.0&&lightCosine>0.0) {
          let origin=offsetSurface(triangle,hit,wi); let end=offsetOrigin(light.position,light.normal,-wi);
          let segment=end-origin; let distance=length(segment);
          let shadow=anyHit(Ray(origin,0.0,segment/distance,distance*(1.0-1e-6)));
          if(shadow.error==5u && !PRECISE_TRANSPORT) {point.valid=2u;break;}
          if(shadow.error!=0u) {reportTransportError(1u,1u,pixel,depth,shadow.triangle,medium);}
          if(shadow.id==NO_HIT) {point.direct+=point.weight*light.emission*cosine/(light.pdfArea*d2/lightCosine);}
        }
      }
      break;
    }
    if(material.kind==5u) {
      if(depth==params.maxDepth) {break;}
      if(!PRECISE_TRANSPORT && needsPreciseOrigin(ray,triangle,hit)) {point.valid=2u;break;}
      let event=sampleThinDielectric(ray.direction,n,materialIor(material,wavelength),sample1D(params.frame,dimension+5u,pixel,params.seed));
      previous=position;
      if(depth>=4u) {beta=rouletteWeight(beta,etaScale,sample1D(params.frame,dimension+6u,pixel,params.seed));if(all(beta==vec3f(0))) {break;}}
      let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
      ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;depth++;crossings=0u;continue;
    }
    if(!PRECISE_TRANSPORT && needsPreciseOrigin(ray,triangle,hit)) {point.valid=2u;break;}
    let entering=dot(ng,ray.direction)<0.0;
    let nextMedia=changeMedium(media,hit.triangle,entering);
    if(nextMedia.error!=0u) {if(!PRECISE_TRANSPORT) {point.valid=2u;break;} reportTransportError(2u,1u,pixel,depth,hit.triangle,medium);break;}
    let eta=mediumIor(nextMedia,wavelength)/mediumIor(media,wavelength);
    if(eta==1.0) {
      media=nextMedia;medium=activeMedium(media);previous=position;
      let event=DielectricSample(ray.direction,1.0,1u);
      let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
      ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;continue;
    }
    if(depth==params.maxDepth) {break;}
    let ns=shadingNormal(triangle,hit);
    let event=sampleDielectricSurface(ray.direction,n,select(-ns,ns,entering),eta,sample1D(params.frame,dimension+5u,pixel,params.seed),false);
    if(event.weight==0.0) {break;} beta*=event.weight;
    if(event.transmitted!=0u) {media=nextMedia;medium=activeMedium(media);etaScale*=eta*eta;}
    previous=position;
    if(depth>=4u) {beta=rouletteWeight(beta,etaScale,sample1D(params.frame,dimension+6u,pixel,params.seed));if(all(beta==vec3f(0))) {break;}}
    let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
    ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;
    depth++;crossings=0u;
  }
  return point;
}
fn renderCameraPoint(id:vec2u) {
  if(any(id>=params.size)) {return;} let pixel=id.y*params.size.x+id.x;
  let jitter=vec2f(sample1D(params.frame,0u,pixel,params.seed),sample1D(params.frame,1u,pixel,params.seed));
  let uv=(vec2f(id)+jitter)/vec2f(params.size); let p=vec2f(2.0*uv.x-1.0,1.0-2.0*uv.y);
  let direction=normalize(params.forward.xyz+p.x*f32(params.size.x)/f32(params.size.y)*params.right.xyz+p.y*params.up.xyz);
  let wavelength=iterationWavelength();
  var point=cameraPoint(Ray(params.eye.xyz,0.00001,direction,1e20),pixel,wavelength.wavelength);
  if(!PRECISE_TRANSPORT && point.valid==2u) {
    points[pixel].padding0=1u;
    enqueueTransportRetry(pixel,params.size.x*params.size.y);return;
  }
  points[pixel].padding0=0u;
  if(wavelength.wavelength!=0.0) {
    let xyzWeight=cieXyz(wavelength.wavelength)/(wavelength.pdf*CIE_Y_INTEGRAL);
    point.weight=point.weight.x*xyzWeight;point.direct=point.direct.x*xyzWeight;
  }
  points[pixel].position=point.position; points[pixel].surface=point.surface; points[pixel].normal=point.normal; points[pixel].valid=point.valid;
  points[pixel].weight=point.weight;points[pixel].direct=point.direct;points[pixel].phi=vec3f(0);points[pixel].M=0u;
}
fn tracePhoton(id:vec3u) {
  if(id.x>=sppm.batchCount) {return;}
  let stride=params.maxDepth+1u; let first=id.x*stride;
  for(var i=0u;i<stride;i++) {photons[first+i].valid=0u;}
  photons[first].padding=0u;
  if(params.lightCount==0u) {return;}
  // Global index within the iteration; batch partition never changes samples.
  let index=sppm.batchStart+id.x; let seed=params.seed^hash32(sppm.iteration+0x51eedu); let stream=0x70686f74u;
  let wavelength=iterationWavelength().wavelength;
  let light=sampleLightAtWavelength(sample1D(index,0u,stream,seed),vec2f(sample1D(index,1u,stream,seed),sample1D(index,2u,stream,seed)),params.lightCount,wavelength);
  let direction=cosineDirection(light.normal,vec2f(sample1D(index,3u,stream,seed),sample1D(index,4u,stream,seed)));
  var beta=light.emission*PI/light.pdfArea;
  var ray=Ray(offsetOrigin(light.position,light.normal,direction),0.0,direction,1e20);
  var originLow=vec3f(0);
  var media:MediumSet;var medium=NO_HIT;var previous=light.position;
  var crossings=0u;
  for(var depth=0u;depth<=params.maxDepth;) {
    crossings++;
    if(crossings>arrayLength(&triangles)+params.maxDepth+1u) {reportTransportError(2u,2u,index,depth,NO_HIT,medium);break;}
    let hit=closestHitWithOrigin(ray,originLow);
    if(!PRECISE_TRANSPORT && hit.error==5u) {photons[first].padding=1u;break;}
    if(hit.error!=0u) {reportTransportError(1u,2u,index,depth,hit.triangle,medium);break;}
    if(hit.id==NO_HIT) {if(medium!=NO_HIT) {if(!PRECISE_TRANSPORT) {photons[first].padding=1u;break;} reportTransportError(2u,2u,index,depth,NO_HIT,medium);} break;}
    let triangle=triangles[hit.triangle];
    if(triangle.material>=arrayLength(&materials)) {reportTransportError(3u,2u,index,depth,hit.triangle,medium);break;}
    let material=materials[triangle.material];
    if(!PRECISE_TRANSPORT && medium!=NO_HIT && material.kind!=2u) {photons[first].padding=1u;break;}
    let ng=geometricNormal(triangle);
    let position=surfacePosition(triangle,hit);let n=select(ng,-ng,dot(ng,-ray.direction)<0.0);
    if(medium!=NO_HIT) {let inside=materials[triangles[medium].material];beta*=exp(-spectralColor(inside.absorption,inside.absorptionOffset,wavelength)*length(position-previous));}
    if(!all(beta>=vec3f(0))||!all(beta<vec3f(FAR))) {reportTransportError(5u,2u,index,depth,hit.triangle,medium);break;}
    if(material.kind==1u) {break;}
    let dimension=5u+depth*7u;var wi:vec3f;
    if(material.kind==0u||material.kind==3u||material.kind==4u) {
      // The first direct diffuse hit is estimated by camera NEE, not photons.
      if(depth>0u&&any(beta>vec3f(0))) {photons[first+depth]=Photon(position,triangle.surface,n,1u,beta,0u,vec3i(0),0u);}
      if(depth==params.maxDepth) {break;}
      if(sample1D(index,dimension+5u,stream,seed)<coatingProbability(material)) {
        let ns=shadingNormal(triangle,hit);let oriented=select(ns,-ns,dot(ns,n)<0.0);
        wi=coatingDirection(ray.direction,n,oriented);
      } else {
        beta*=surfaceColor(material,position,wavelength);
        wi=cosineDirection(n,vec2f(sample1D(index,dimension+3u,stream,seed),sample1D(index,dimension+4u,stream,seed)));
      }
    } else if(material.kind==5u) {
      if(depth==params.maxDepth) {break;}
      if(!PRECISE_TRANSPORT && needsPreciseOrigin(ray,triangle,hit)) {photons[first].padding=1u;break;}
      wi=sampleThinDielectric(ray.direction,n,materialIor(material,wavelength),sample1D(index,dimension+5u,stream,seed)).direction;
    } else {
      if(!PRECISE_TRANSPORT && needsPreciseOrigin(ray,triangle,hit)) {photons[first].padding=1u;break;}
      let entering=dot(ng,ray.direction)<0.0;
      let nextMedia=changeMedium(media,hit.triangle,entering);
      if(nextMedia.error!=0u) {if(!PRECISE_TRANSPORT) {photons[first].padding=1u;break;} reportTransportError(2u,2u,index,depth,hit.triangle,medium);break;}
      let eta=mediumIor(nextMedia,wavelength)/mediumIor(media,wavelength);
      if(eta==1.0) {
        media=nextMedia;medium=activeMedium(media);previous=position;
        let event=DielectricSample(ray.direction,1.0,1u);
        let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
        ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;continue;
      }
      if(depth==params.maxDepth) {break;}
      let ns=shadingNormal(triangle,hit);
      let event=sampleDielectricSurface(ray.direction,n,select(-ns,ns,entering),eta,sample1D(index,dimension+5u,stream,seed),true);
      if(event.weight==0.0) {break;}beta*=event.weight;wi=event.direction;
      if(event.transmitted!=0u) {media=nextMedia;medium=activeMedium(media);}
    }
    // Importance transport has no radiance eta compression to compensate.
    if(depth>=4u) {beta=rouletteWeight(beta,1.0,sample1D(index,dimension+6u,stream,seed));if(all(beta==vec3f(0))) {break;}}
    previous=position;
    if(material.kind==2u||material.kind==5u) {let origin=transportOrigin(ray,originLow,triangle,hit,wi);ray=Ray(origin.position,0.0,wi,1e20);originLow=origin.residual;}
    else {ray=Ray(offsetSurface(triangle,hit,wi),0.0,wi,1e20);originLow=vec3f(0);}
    depth++;crossings=0u;
  }
}
@compute @workgroup_size(64) fn hashMain(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=sppm.batchCount*(params.maxDepth+1u)||photons[id.x].valid==0u) {return;}
  let cell=vec3i(floor(photons[id.x].position/sppm.initialRadius));
  photons[id.x].cell=cell;
  photons[id.x].next=atomicExchange(&heads[cellHash(cell)],id.x+1u);
}
@compute @workgroup_size(8,8) fn gatherMain(@builtin(global_invocation_id) invocation:vec3u) {
  if(any(invocation.xy>=params.tile.zw)) {return;}let id=invocation.xy+params.tile.xy;
  if(any(id>=params.size)) {return;}let pixel=id.y*params.size.x+id.x;let point=points[pixel];
  if(point.valid==0u) {return;}
  let radius=pointRadius(point);let cell=vec3i(floor(point.position/sppm.initialRadius));
  var phi=vec3f(0);var count=0u;
  // The radius shrinks; skip cells outside its AABB, conservatively rounded.
  let error=8e-7*max(1.0,max(abs(point.position.x),max(abs(point.position.y),abs(point.position.z))));
  let lower=max(cell-vec3i(1),vec3i(floor((point.position-vec3f(radius+error))/sppm.initialRadius)));
  let upper=min(cell+vec3i(1),vec3i(floor((point.position+vec3f(radius+error))/sppm.initialRadius)));
  for(var z=lower.z;z<=upper.z;z++) {for(var y=lower.y;y<=upper.y;y++) {for(var x=lower.x;x<=upper.x;x++) {
    let targetCell=vec3i(x,y,z);var link=atomicLoad(&heads[cellHash(targetCell)]);var visited=0u;
    while(link!=0u) {
      let index=link-1u;
      if(index>=sppm.batchCount*(params.maxDepth+1u)||visited>=arrayLength(&photons)) {reportTransportError(4u,3u,pixel,0u,index,NO_HIT);return;}
      let photon=photons[index];let delta=photon.position-point.position;
      if(all(photon.cell==targetCell)&&photon.surface==point.surface&&dot(photon.normal,point.normal)>0.95&&dot(delta,delta)<=radius*radius&&abs(dot(delta,point.normal))<=0.1*radius) {phi+=point.weight*photon.flux;count++;}
      link=photon.next;visited++;
    }
  }}}
  points[pixel].phi+=phi;points[pixel].M+=count;
}
@compute @workgroup_size(8,8) fn updateMain(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=params.size)) {return;}let pixel=id.y*params.size.x+id.x;var point=points[pixel];
  var radius=pointRadius(point);
  if(point.M>0u) {
    let N=point.N+(2.0/3.0)*f32(point.M);let ratio=N/(point.N+f32(point.M));
    radius*=sqrt(ratio);point.tau=(point.tau+point.phi)*ratio;point.N=N;
  }
  point.radius=radius;point.directSum+=point.direct;point.iterations++;
  let iterations=f32(point.iterations);let emitted=iterations*f32(sppm.photonsPerIteration);
  let radiance=point.directSum/iterations+point.tau/(PI*radius*radius*emitted);
  if(!all(radiance>=vec3f(0))||!all(radiance<vec3f(FAR))) {reportTransportError(5u,4u,pixel,0u,NO_HIT,NO_HIT);return;}
  points[pixel]=point;accumulation[pixel]=vec4f(radiance*iterations,iterations);
  textureStore(outputImage,vec2i(id.xy),vec4f(radiance,1));
}

@compute @workgroup_size(8,8)
fn densityMain(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=params.size)){return;}
  let point=points[id.y*params.size.x+id.x];
  let denominator=PI*point.radius*point.radius*f32(point.iterations)*f32(sppm.photonsPerIteration);
  let density=select(0.0,point.N/max(denominator,0.000001),point.valid!=0u);
  let t=clamp(log2(1.0+density*1000.0)/14.0,0.0,1.0);
  textureStore(outputImage,vec2i(id.xy),vec4f(t,t*t,select(0.0,1.0-t,t>0.0),1));
}

@compute @workgroup_size(8,8) fn cameraMain(@builtin(global_invocation_id) invocation:vec3u) {
  if(any(invocation.xy>=params.tile.zw)) {return;}
  renderCameraPoint(invocation.xy+params.tile.xy);
}
@compute @workgroup_size(64) fn cameraRepairMain(@builtin(global_invocation_id) invocation:vec3u) {
  let index=transportRetryIndex(invocation.x,params.size.x*params.size.y);if(index==NO_HIT) {return;}
  let id=vec2u(index%params.size.x,index/params.size.x);
  if(any(id>=params.size)) {return;}
  if(points[id.y*params.size.x+id.x].padding0==0u) {return;}
  renderCameraPoint(id);
}
@compute @workgroup_size(64) fn photonMain(@builtin(global_invocation_id) id:vec3u) {
  tracePhoton(id);
  if(id.x<sppm.batchCount && !PRECISE_TRANSPORT && photons[id.x*(params.maxDepth+1u)].padding!=0u) {enqueueTransportRetry(id.x,sppm.batchCount);}
}
@compute @workgroup_size(64) fn photonRepairMain(@builtin(global_invocation_id) invocation:vec3u) {
  let index=transportRetryIndex(invocation.x,sppm.batchCount);if(index==NO_HIT) {return;}
  if(photons[index*(params.maxDepth+1u)].padding==0u) {return;}
  tracePhoton(vec3u(index,0,0));
}
