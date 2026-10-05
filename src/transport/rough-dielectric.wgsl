// Isotropic GGX, visible-normal sampling. Directions point away from the surface.
struct RoughEval { f: vec3f, pdf: f32 }
struct RoughSample { direction: vec3f, weight: vec3f, pdf: f32, transmitted: u32 }
fn roughFrame(n: vec3f) -> mat3x3f {
  let axis=select(vec3f(0,0,1),vec3f(0,1,0),abs(n.z)>0.999);
  let x=normalize(cross(axis,n));return mat3x3f(x,cross(n,x),n);
}
fn ggxD(m: vec3f, alpha: f32) -> f32 {
  if(m.z<=0.0) {return 0.0;}
  // Avoid cancellation at very small roughness when m.z rounds to one in f32.
  let a2=alpha*alpha;let d=dot(m.xy,m.xy)+a2*m.z*m.z;
  return a2/(PI*d*d);
}
fn ggxLambda(v: vec3f, alpha: f32) -> f32 {
  let z2=v.z*v.z;
  return 0.5*(sqrt(1.0+alpha*alpha*(v.x*v.x+v.y*v.y)/max(z2,1e-20))-1.0);
}
fn ggxVisible(wo: vec3f, alpha: f32, u: vec2f) -> vec3f {
  let vh=normalize(vec3f(alpha*wo.xy,wo.z));
  let lensq=dot(vh.xy,vh.xy);
  var t1=vec3f(1,0,0);if(lensq>0.0) {t1=vec3f(-vh.y,vh.x,0)/sqrt(lensq);}
  let t2=cross(vh,t1);let r=sqrt(u.x);let phi=2.0*PI*u.y;
  let p1=r*cos(phi);var p2=r*sin(phi);
  p2=mix(sqrt(max(0.0,1.0-p1*p1)),p2,0.5*(1.0+vh.z));
  let nh=p1*t1+p2*t2+sqrt(max(0.0,1.0-p1*p1-p2*p2))*vh;
  return normalize(vec3f(alpha*nh.xy,max(0.0,nh.z)));
}
fn roughDielectricEval(material: Material, woWorld: vec3f, wiWorld: vec3f, ng: vec3f, ns: vec3f, eta: f32, wavelength: f32, importance: bool) -> RoughEval {
  var result=RoughEval(vec3f(0),0.0);
  let frame=roughFrame(ns);let wo=transpose(frame)*woWorld;let wi=transpose(frame)*wiWorld;
  if(wo.z<=0.0 || abs(wi.z)<1e-8 || dot(woWorld,ng)<=0.0) {return result;}
  let transmission=wi.z<0.0;
  if((dot(wiWorld,ng)<0.0)!=transmission) {return result;}
  let thin=material.kind==5u;let alpha=max(1e-4,material.textureParams.x*material.textureParams.x);
  var reflectedWi=wi; if(thin && transmission) {reflectedWi.z=-reflectedWi.z;}
  var halfVector=wo+reflectedWi;
  if(!thin && transmission) {halfVector=wo+eta*wi;}
  if(dot(halfVector,halfVector)<1e-16) {return result;}
  var m=normalize(halfVector);if(m.z<0.0) {m=-m;}
  let om=dot(wo,m);let im=dot(wi,m);
  if(om<=0.0 || (!thin && transmission && im>=0.0)) {return result;}
  let d=ggxD(m,alpha);let g1=1.0/(1.0+ggxLambda(wo,alpha));
  let g=1.0/(1.0+ggxLambda(wo,alpha)+ggxLambda(wi,alpha));
  let pdfM=d*g1*om/wo.z;
  var r=dielectricFresnel(om,eta);if(thin) {r=thinReflectance(om,eta);}
  if(!transmission || thin) {
    let probability=select(r,1.0-r,transmission);
    result.f=vec3f(probability*d*g/(4.0*abs(wo.z*wi.z)));
    result.pdf=pdfM*probability/(4.0*om);
    if(transmission) {result.f*=spectralColor(material.color,material.spectrumOffset,wavelength);}
  } else {
    let denominator=om+eta*im;let den2=denominator*denominator;
    if(den2<1e-20) {return result;}
    let mode=select(1.0/(eta*eta),1.0,importance);
    result.f=vec3f((1.0-r)*d*g*abs(om*im)*eta*eta*mode/(abs(wo.z*wi.z)*den2));
    result.pdf=pdfM*(1.0-r)*abs(im)*eta*eta/den2;
  }
  result.f*=shadingNormalWeight(woWorld,wiWorld,ng,ns,importance);
  return result;
}
fn sampleRoughDielectric(material: Material, direction: vec3f, ng: vec3f, ns: vec3f, eta: f32, wavelength: f32, u: vec2f, eventRandom: f32, importance: bool) -> RoughSample {
  let frame=roughFrame(ns);let wo=transpose(frame)*(-direction);
  if(wo.z<=0.0) {return RoughSample(direction,vec3f(0),0.0,0u);}
  let m=ggxVisible(wo,max(1e-4,material.textureParams.x*material.textureParams.x),u);
  let thin=material.kind==5u;var r=dielectricFresnel(dot(wo,m),eta);
  if(thin) {r=thinReflectance(dot(wo,m),eta);}
  let transmitted=eventRandom>=r && r<1.0;
  var wi=reflect(-wo,m);
  if(transmitted) {
    if(thin) {wi.z=-wi.z;} else {wi=refract(-wo,m,1.0/eta);}
  }
  if(dot(wi,wi)==0.0) {return RoughSample(direction,vec3f(0),0.0,0u);}
  let world=normalize(frame*wi);
  // A rejected microfacet event cannot be reclassified as a boundary crossing.
  if((dot(world,ng)<0.0)!=transmitted) {return RoughSample(world,vec3f(0),0.0,u32(transmitted));}
  let evaluated=roughDielectricEval(material,-direction,world,ng,ns,eta,wavelength,importance);
  var weight=vec3f(0);if(evaluated.pdf>0.0) {weight=evaluated.f*abs(wi.z)/evaluated.pdf;}
  if(!all(abs(world)<vec3f(FAR)) || !all(abs(weight)<vec3f(FAR))) {
    return RoughSample(direction,vec3f(0),0.0,0u);
  }
  return RoughSample(world,weight,evaluated.pdf,u32(transmitted));
}
// Smooth branch preserves the original transport exactly at roughness zero.
fn sampleEditedDielectric(material: Material, direction: vec3f, ng: vec3f, ns: vec3f, eta: f32, wavelength: f32, u: vec2f, random: f32, importance: bool) -> RoughSample {
  if(material.textureParams.x>0.0) {return sampleRoughDielectric(material,direction,ng,ns,eta,wavelength,u,random,importance);}
  var event:DielectricSample;
  if(material.kind==5u) {event=sampleThinDielectric(direction,ng,eta,random);}
  else {event=sampleDielectricSurface(direction,ng,ns,eta,random,importance);}
  var weight=vec3f(event.weight);
  if(material.kind==5u && event.transmitted!=0u) {weight*=spectralColor(material.color,material.spectrumOffset,wavelength);}
  return RoughSample(event.direction,weight,0.0,event.transmitted);
}
struct RoughLight { radiance: vec3f, error: u32 }
fn roughDirect(material: Material, position: vec3f, triangle: Triangle, hit: Hit, wo: vec3f, ng: vec3f, ns: vec3f, eta: f32, wavelength: f32, light: LightSample, strategy: u32) -> RoughLight {
  var wi:vec3f;var pdf:f32;var endpoint:vec3f;
  if(light.padding==1.0) {wi=light.position;pdf=light.pdfArea;}
  else {
    let delta=light.position-position;let d2=dot(delta,delta);if(d2<=0.0) {return RoughLight(vec3f(0),0u);}
    wi=normalize(delta);let lc=dot(light.normal,-wi);if(lc<=0.0) {return RoughLight(vec3f(0),0u);}
    pdf=light.pdfArea*d2/lc;endpoint=offsetOrigin(light.position,light.normal,-wi);
  }
  let evaluated=roughDielectricEval(material,wo,wi,ng,ns,eta,wavelength,false);
  if(evaluated.pdf<=0.0 || pdf<=0.0) {return RoughLight(vec3f(0),0u);}
  let origin=offsetSurface(triangle,hit,wi);var shadowRay=Ray(origin,0.0,wi,1e20);
  if(light.padding==0.0) {let segment=endpoint-origin;let distance=length(segment);shadowRay=Ray(origin,0.0,segment/distance,distance*(1.0-1e-6));}
  let shadow=anyHit(shadowRay);
  if(shadow.error!=0u || shadow.id!=NO_HIT) {return RoughLight(vec3f(0),shadow.error);}
  let weight=select(1.0,powerHeuristic(pdf,evaluated.pdf),strategy==0u);
  return RoughLight(evaluated.f*light.emission*abs(dot(ns,wi))*weight/pdf,0u);
}
