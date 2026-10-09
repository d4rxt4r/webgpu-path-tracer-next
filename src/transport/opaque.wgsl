// Physical conductors: complex Fresnel + isotropic GGX/Smith.
// Plastic: Ashikhmin-Shirley FresnelBlend with an isotropic GGX distribution.
fn schlick(f0: vec3f, c: f32) -> vec3f {return f0+(vec3f(1)-f0)*pow(1.0-clamp(c,0.0,1.0),5.0);}
fn complexFresnel(cosine: f32, eta: vec3f, k: vec3f) -> vec3f {
  let c=clamp(abs(cosine),0.0,1.0);let c2=c*c;let s2=1.0-c2;
  let e2=eta*eta;let k2=k*k;let t0=e2-k2-vec3f(s2);
  let a2b2=sqrt(t0*t0+4.0*e2*k2);let a=sqrt(max(vec3f(0),(a2b2+t0)*0.5));
  let rs=(a2b2+vec3f(c2)-2.0*c*a)/(a2b2+vec3f(c2)+2.0*c*a);
  let rp=rs*(c2*a2b2+vec3f(s2*s2)-2.0*c*a*s2)/(c2*a2b2+vec3f(s2*s2)+2.0*c*a*s2);
  return clamp((rs+rp)*0.5,vec3f(0),vec3f(1));
}
fn opaqueFresnel(material: Material, c: f32, wavelength: f32) -> vec3f {
  if(material.kind==6u) {return complexFresnel(c,spectralColor(material.color,material.spectrumOffset,wavelength),spectralColor(material.absorption,material.absorptionOffset,wavelength));}
  if(material.kind==8u) {let f0=pow((material.ior-1.0)/(material.ior+1.0),2.0);return schlick(vec3f(f0),c);}
  return schlick(spectralColor(material.color,material.spectrumOffset,wavelength),c);
}
fn opaqueEval(material: Material, wo: vec3f, wi: vec3f, n: vec3f, wavelength: f32) -> RoughEval {
  let co=dot(n,wo);let ci=dot(n,wi);var result=RoughEval(vec3f(0),0.0);
  if(co<=0.0 || ci<=0.0) {return result;}
  if(material.kind==10u) {
    let si=sqrt(max(0.0,1.0-ci*ci));let so=sqrt(max(0.0,1.0-co*co));
    var angular=0.0;
    if(si>1e-4 && so>1e-4) {
      let azimuth=max(0.0,dot(wi-n*ci,wo-n*co)/(si*so));
      // sin(alpha)*tan(beta), evaluated without division by a grazing cosine.
      angular=azimuth*si*so/max(1e-7,max(ci,co));
    }
    result.f=surfaceColor(material,vec3f(0),wavelength)*(material.textureParams.y+material.textureParams.z*angular)/PI;
    result.pdf=ci/PI;return result;
  }
  let plastic=material.kind==8u;let probability=select(1.0,0.5,plastic);
  if(plastic) {
    let f0=pow((material.ior-1.0)/(material.ior+1.0),2.0);
    result.f=(28.0/(23.0*PI))*surfaceColor(material,vec3f(0),wavelength)*(1.0-f0)*(1.0-pow(1.0-0.5*ci,5.0))*(1.0-pow(1.0-0.5*co,5.0));
    result.pdf=0.5*ci/PI;
  }
  if(material.textureParams.x==0.0) {return result;}
  let frame=roughFrame(n);let o=transpose(frame)*wo;let i=transpose(frame)*wi;
  let h=normalize(o+i);let oh=dot(o,h);let alpha=max(1e-4,material.textureParams.x*material.textureParams.x);
  let d=ggxD(h,alpha);let g1=1.0/(1.0+ggxLambda(o,alpha));
  result.pdf+=probability*d*g1/(4.0*co);
  if(plastic) {result.f+=opaqueFresnel(material,oh,wavelength)*d/(4.0*oh*max(co,ci));}
  else {let g=1.0/(1.0+ggxLambda(o,alpha)+ggxLambda(i,alpha));result.f=opaqueFresnel(material,oh,wavelength)*d*g/(4.0*co*ci);}
  return result;
}
fn sampleOpaque(material: Material, direction: vec3f, n: vec3f, wavelength: f32, u: vec2f, random: f32) -> RoughSample {
  let wo=-direction;let plastic=material.kind==8u;let specular= !plastic || random<0.5;
  var wi=cosineDirection(n,u);
  if(material.kind==10u) {
    let evaluated=opaqueEval(material,wo,wi,n,wavelength);
    return RoughSample(wi,evaluated.f*PI,evaluated.pdf,0u);
  }
  if(specular) {
    if(material.textureParams.x==0.0) {wi=reflect(direction,n);return RoughSample(wi,opaqueFresnel(material,dot(wo,n),wavelength)*select(1.0,2.0,plastic),0.0,1u);}
    let frame=roughFrame(n);let o=transpose(frame)*wo;
    let h=ggxVisible(o,max(1e-4,material.textureParams.x*material.textureParams.x),u);wi=normalize(frame*reflect(-o,h));
  }
  let evaluated=opaqueEval(material,wo,wi,n,wavelength);var weight=vec3f(0);
  if(evaluated.pdf>0.0) {weight=evaluated.f*max(0.0,dot(n,wi))/evaluated.pdf;}
  return RoughSample(wi,weight,evaluated.pdf,0u);
}
fn opaqueDirect(material: Material, position: vec3f, triangle: Triangle, hit: Hit, wo: vec3f, n: vec3f, wavelength: f32, light: LightSample, strategy: u32) -> RoughLight {
  var wi:vec3f;var pdf:f32;var endpoint:vec3f;
  if(light.padding==1.0) {wi=light.position;pdf=light.pdfArea;}
  else {let delta=light.position-position;let d2=dot(delta,delta);if(d2<=0.0) {return RoughLight(vec3f(0),0u);}wi=normalize(delta);let lc=dot(light.normal,-wi);if(lc<=0.0) {return RoughLight(vec3f(0),0u);}pdf=light.pdfArea*d2/lc;endpoint=offsetOrigin(light.position,light.normal,-wi);}
  let evaluated=opaqueEval(material,wo,wi,n,wavelength);
  if(pdf<=0.0 || evaluated.pdf<=0.0) {return RoughLight(vec3f(0),0u);}
  let origin=offsetSurface(triangle,hit,wi);var shadowRay=Ray(origin,0.0,wi,1e20);
  if(light.padding==0.0) {let segment=endpoint-origin;let distance=length(segment);shadowRay=Ray(origin,0.0,segment/distance,distance*(1.0-1e-6));}
  let shadow=anyHit(shadowRay);if(shadow.error!=0u || shadow.id!=NO_HIT) {return RoughLight(vec3f(0),shadow.error);}
  let weight=select(1.0,powerHeuristic(pdf,evaluated.pdf),strategy==0u);
  return RoughLight(evaluated.f*light.emission*max(0.0,dot(n,wi))*weight/pdf,0u);
}
