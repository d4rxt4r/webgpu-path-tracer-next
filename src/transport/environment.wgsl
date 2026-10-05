struct EnvironmentParams { colorStrength: vec4f, modeRotationBackground: vec4f, sampling: vec4f, bounds: vec4f, padding: vec4f }
@group(0) @binding(12) var<uniform> environment: EnvironmentParams;
@group(0) @binding(13) var environmentMap: texture_2d<f32>;
@group(0) @binding(14) var environmentCdf: texture_2d<f32>;
@group(0) @binding(15) var illuminantBasis: texture_2d<f32>;
fn environmentRotation(v: vec3f, angle: f32) -> vec3f {
  return vec3f(cos(angle)*v.x+sin(angle)*v.z,v.y,-sin(angle)*v.x+cos(angle)*v.z);
}
fn environmentUv(direction: vec3f) -> vec2f {
  let d=environmentRotation(direction,-environment.modeRotationBackground.y);
  return vec2f(fract(atan2(d.z,d.x)/(2.0*PI)+0.5),acos(clamp(d.y,-1.0,1.0))/PI);
}
fn environmentTexel(p:vec2i, level:i32) -> vec3f {
  let size=vec2i(textureDimensions(environmentMap,u32(level)));
  return textureLoad(environmentMap,vec2i((p.x%size.x+size.x)%size.x,clamp(p.y,0,size.y-1)),level).rgb;
}
fn environmentBilinear(uv:vec2f, level:i32) -> vec3f {
  let p=uv*vec2f(textureDimensions(environmentMap,u32(level)))-0.5;let base=vec2i(floor(p));let f=fract(p);
  return mix(mix(environmentTexel(base,level),environmentTexel(base+vec2i(1,0),level),f.x),mix(environmentTexel(base+vec2i(0,1),level),environmentTexel(base+vec2i(1,1),level),f.x),f.y);
}
fn environmentBasis(index:i32, wavelength:f32) -> f32 {
  // PBRT's 32 uniformly spaced illuminant samples, 380..720 nm.
  let p=clamp((wavelength-380.0)*31.0/340.0,0.0,31.0);let lo=min(i32(p),30);
  return mix(textureLoad(illuminantBasis,vec2i(lo,index),0).x,textureLoad(illuminantBasis,vec2i(lo+1,index),0).x,p-f32(lo));
}
fn environmentSpectrum(rgb:vec3f,wavelength:f32) -> vec3f {
  if(wavelength==0.0) {return rgb;}
  var weights:array<f32,7>;
  if(rgb.r<=rgb.g && rgb.r<=rgb.b) {
    weights[0]=rgb.r;
    weights[1]=min(rgb.g,rgb.b)-rgb.r;weights[5]=max(0.0,rgb.g-rgb.b);weights[6]=max(0.0,rgb.b-rgb.g);
  } else if(rgb.g<=rgb.r && rgb.g<=rgb.b) {
    weights[0]=rgb.g;
    weights[2]=min(rgb.r,rgb.b)-rgb.g;weights[4]=max(0.0,rgb.r-rgb.b);weights[6]=max(0.0,rgb.b-rgb.r);
  } else {
    weights[0]=rgb.b;
    weights[3]=min(rgb.r,rgb.g)-rgb.b;weights[4]=max(0.0,rgb.r-rgb.g);weights[5]=max(0.0,rgb.g-rgb.r);
  }
  var result=0.0;
  for(var i=0;i<7;i++) {result+=weights[i]*environmentBasis(i,wavelength);}
  return vec3f(max(0.0,result));
}
fn environmentRadiance(direction:vec3f,wavelength:f32,primary:bool) -> vec3f {
  if(environment.modeRotationBackground.x==0.0 || (primary && environment.modeRotationBackground.z==0.0)) {return vec3f(0);}
  var color=environment.colorStrength.rgb;
  if(environment.modeRotationBackground.x==2.0) {
    let uv=environmentUv(direction);var level=0.0;if(primary) {level=environment.sampling.x;}
    let lo=i32(floor(level));let hi=min(lo+1,i32(textureNumLevels(environmentMap))-1);
    color*=mix(environmentBilinear(uv,lo),environmentBilinear(uv,hi),fract(level));
  }
  if(primary) {color*=environment.modeRotationBackground.w;}
  else {color*=environment.colorStrength.w;}
  return environmentSpectrum(color,wavelength);
}
fn environmentPdf(direction:vec3f) -> f32 {
  if(environment.modeRotationBackground.x==1.0) {return 1.0/(4.0*PI);}
  let size=textureDimensions(environmentCdf);let p=min(vec2u(environmentUv(direction)*vec2f(size)),size-1u);
  return textureLoad(environmentCdf,vec2i(p),0).z;
}
struct EnvironmentSample { direction:vec3f, pdf:f32, radiance:vec3f, padding:f32 }
fn sampleEnvironment(u:vec3f,wavelength:f32) -> EnvironmentSample {
  var direction:vec3f;
  if(environment.modeRotationBackground.x==1.0) {
    let y=1.0-2.0*u.x;let r=sqrt(max(0.0,1.0-y*y));let phi=2.0*PI*u.y;
    direction=vec3f(r*cos(phi),y,r*sin(phi));
  } else {
    let size=textureDimensions(environmentCdf);var low=0u;var high=size.y-1u;
    while(low<high) {let mid=(low+high)/2u;if(u.x<textureLoad(environmentCdf,vec2i(0,i32(mid)),0).y) {high=mid;} else {low=mid+1u;}}
    let y=low;low=0u;high=size.x-1u;
    while(low<high) {let mid=(low+high)/2u;if(u.y<textureLoad(environmentCdf,vec2i(i32(mid),i32(y)),0).x) {high=mid;} else {low=mid+1u;}}
    let x=low;let upper=textureLoad(environmentCdf,vec2i(i32(x),i32(y)),0).x;
    var lower=0.0;if(x>0u) {lower=textureLoad(environmentCdf,vec2i(i32(x-1u),i32(y)),0).x;}
    let fraction=clamp((u.y-lower)/max(upper-lower,1e-20),0.0,1.0);
    let phi=((f32(x)+fraction)/f32(size.x)-0.5)*2.0*PI;
    let cy=mix(cos(f32(y)*PI/f32(size.y)),cos(f32(y+1u)*PI/f32(size.y)),u.z);
    let r=sqrt(max(0.0,1.0-cy*cy));direction=environmentRotation(vec3f(r*cos(phi),cy,r*sin(phi)),environment.modeRotationBackground.y);
  }
  return EnvironmentSample(direction,environmentPdf(direction),environmentRadiance(direction,wavelength,false),0.0);
}
fn environmentRandom(index:u32,dimension:u32,stream:u32,seed:u32) -> vec3f {
  let s=stream^0x656e766du;
  return vec3f(sample1D(index,dimension,s,seed),sample1D(index,dimension+1u,s,seed),sample1D(index,dimension+2u,s,seed));
}
// One light estimator chooses between finite emitters and the environment.
// padding=1 marks a direction and solid-angle PDF instead of an area sample.
fn sampleSceneLight(choice:f32,u:vec2f,lightCount:u32,wavelength:f32) -> LightSample {
  let p=environment.sampling.y;
  if(p>0.0 && choice<p) {
    let light=sampleEnvironment(vec3f(choice/p,u),wavelength);
    return LightSample(light.direction,light.pdf*p,-light.direction,1.0,light.radiance,NO_HIT);
  }
  var light=sampleLightAtWavelength((choice-p)/max(1.0-p,1e-20),u,lightCount,wavelength);
  light.pdfArea*=1.0-p;
  return light;
}
