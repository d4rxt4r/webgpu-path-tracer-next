const WEAR_MASK=7u;
// Object-space surface detail shared by radiance, photons and denoise guides.
// These hashes deliberately do not use the render sampler or its dimensions.
fn wearHash(input: u32) -> u32 {
  var v=input;v^=v>>16u;v*=0x7feb352du;v^=v>>15u;v*=0x846ca68bu;v^=v>>16u;return v;
}
fn wearRandom(seed: u32) -> f32 {return f32(wearHash(seed)>>8u)*(1.0/16777216.0);}
fn wearNoise(p: vec2f, seed: u32) -> f32 {
  let cell=vec2i(floor(p));let f=fract(p);let u=f*f*(3.0-2.0*f);
  let base=(bitcast<u32>(cell.x)*1597334677u)^(bitcast<u32>(cell.y)*3812015801u)^seed;
  let x=(bitcast<u32>(cell.x+1)*1597334677u)^(bitcast<u32>(cell.y)*3812015801u)^seed;
  let y=(bitcast<u32>(cell.x)*1597334677u)^(bitcast<u32>(cell.y+1)*3812015801u)^seed;
  let xy=(bitcast<u32>(cell.x+1)*1597334677u)^(bitcast<u32>(cell.y+1)*3812015801u)^seed;
  return mix(mix(wearRandom(base),wearRandom(x),u.x),mix(wearRandom(y),wearRandom(xy),u.x),u.y);
}
// gradient.xy is a small bump field. All marks have
// smooth edges, and scratches fit within their cells, including their end caps.
struct WearPlane { roughness: f32, gradient: vec2f }
fn wearPlane(uv: vec2f, bounds: vec2f, strength: f32, seed: u32, config: WearEffect, effect: u32) -> WearPlane {
  var result=WearPlane(0.0,vec2f(0));
  // wear-begin-0
  if(effect==0u) {
    let grid=uv*12.0;let cell=vec2i(floor(grid));let p=fract(grid)-0.5;
    let key=(bitcast<u32>(cell.x)*1597334677u)^(bitcast<u32>(cell.y)*3812015801u)^seed;
    if(wearRandom(key)<config.shape.w) {
      let angle=config.detail.x+2.0*config.detail.y*wearRandom(key^0x1a25u);let axis=vec2f(cos(angle),sin(angle));
      let center=0.16*(vec2f(wearRandom(key^0x235bu),wearRandom(key^0x693du))-0.5);
      let halfLength=clamp((0.22+0.10*config.shape.z*(2.0*wearRandom(key^0xa521u)-1.0))*config.shape.x,0.01,0.40);let delta=p-center;
      let d=delta-axis*clamp(dot(delta,axis),-halfLength,halfLength);
      let width=(0.012+0.012*wearRandom(key^0x3321u))*config.shape.y;let inverseWidth=1.0/(width*width);
      let edge=1.0-smoothstep(0.42,0.5,max(abs(p.x),abs(p.y)));
      let ridge=exp(-dot(d,d)*inverseWidth)*edge;
      result.roughness+=strength*config.base.w*0.35*ridge;
      result.gradient+=strength*config.detail.z*0.000012*ridge*2.0*d*inverseWidth*12.0;
    }
  }
  // wear-end-0
  // wear-begin-1
  if(effect==1u) {
    let angle=config.detail.x;let rotation=mat2x2f(vec2f(cos(angle),-sin(angle)),vec2f(sin(angle),cos(angle)));
    let p=rotation*uv;
    let field=wearNoise(p*7.0,seed^0x432bu);
    let abrasion=smoothstep(1.13-config.shape.z-config.shape.w,1.13-config.shape.z+config.shape.w,field);
    let grain=wearNoise(p*110.0/config.shape.x,seed^0x7543u);
    result.roughness+=strength*config.base.w*abrasion*max(0.0,0.12+0.18*(0.5+(grain-0.5)*config.shape.y));
    // Small directional abrasions; no displacement of the geometric boundary.
    result.gradient+=strength*config.detail.y*abrasion*0.008*(transpose(rotation)*vec2f(sin(p.x*440.0/config.detail.z+field*9.0),sin(p.y*390.0/config.detail.z+field*11.0)));
  }
  // wear-end-1
  // wear-begin-2
  if(effect==2u) {
    for(var i=0u;i<u32(config.shape.x);i++) {
      let key=seed^wearHash(i+137u);
      let center=(vec2f(wearRandom(key),wearRandom(key^0x873bu))-0.5)*bounds*1.3;
      let angle=config.detail.w+(wearRandom(key^0x9a23u)-0.5)*2.0*config.extra.x;let axis=vec2f(cos(angle),sin(angle));
      let delta=uv-center;let p=vec2f(dot(delta,axis),dot(delta,vec2f(-axis.y,axis.x)));
      let radius=vec2f(0.065*config.shape.y,0.095)*(1.0+0.2*config.shape.z*(2.0*wearRandom(key^0x342bu)-1.0));
      let ellipse=p/radius;let envelope=1.0-smoothstep(0.65,1.0,dot(ellipse,ellipse));
      if(envelope>0.0) {
        // Off-centre curved ridges, clipped to an oval and partly rubbed away.
        let curve=length(vec2f(p.x,p.y*0.8+0.03))+0.002*sin(p.y*70.0);
        let ridges=smoothstep(clamp(1.0-0.95*config.detail.x,-1.0,0.95),clamp(1.0-0.35*config.detail.x,-0.9,0.99),cos(curve*1047.1976/config.shape.w));
        let rubbed=select(smoothstep(2.0*config.detail.y-0.8,2.0*config.detail.y-0.4,wearNoise(p*65.0,key^0x2547u)),1.0,config.detail.y==0.0);
        result.roughness+=strength*config.base.w*envelope*rubbed*(0.035+0.22*config.detail.z*ridges);
      }
    }
  }
  // wear-end-2
  return result;
}
struct WearSurface { roughness: f32, normal: vec3f }
fn wearProjection(uv: vec2f, bounds: vec2f, depth: f32, halfDepth: f32, strength: f32, seed: u32, config: WearEffect, effect: u32, back: u32, front: u32) -> WearPlane {
  // Position selects the side even for an inward-facing gathering normal.
  // Blend across the centre plane so concave meshes cannot acquire a seam.
  let width=max(halfDepth*0.05,0.0001);
  let weight=smoothstep(-width,width,depth);
  var result=WearPlane(0.0,vec2f(0));
  for(var side=0u;side<2u;side++) {
    let fraction=select(1.0-weight,weight,side==1u);
    if(fraction>0.0001) {
      let plane=wearPlane(uv,bounds,strength,seed^select(back,front,side==1u),config,effect);
      result.roughness+=fraction*plane.roughness;result.gradient+=fraction*plane.gradient;
    }
  }
  return result;
}
fn dielectricWear(material: Material, position: vec3f, geometric: vec3f, shading: vec3f) -> WearSurface {
  var result=WearSurface(material.textureParams.x,shading);
  if((material.kind!=2u && material.kind!=5u) || !any(material.wearParams.xyz>vec3f(0))) {return result;}
  let relative=mat3x3f(material.worldToTexture[0].xyz,material.worldToTexture[1].xyz,material.worldToTexture[2].xyz);
  let relativeP=(material.worldToTexture*vec4f(position,1)).xyz;
  var worldGradient=vec3f(0);var roughness=0.0;
  for(var effect=0u;effect<3u;effect++) {
    if((WEAR_MASK & (1u<<effect))==0u || material.wearParams[effect]<=0.0) {continue;}
    let config=material.wearEffects[effect];
    var metric=mat3x3f(vec3f(1,0,0),vec3f(0,1,0),vec3f(0,0,1));
    if(config.base.z>0.5){metric=mat3x3f(material.wearPhysical[0].xyz,material.wearPhysical[1].xyz,material.wearPhysical[2].xyz);}
    let transform=(metric*relative)*(1.0/config.base.x);
    let cofactor=mat3x3f(cross(transform[1],transform[2]),cross(transform[2],transform[0]),cross(transform[0],transform[1]));
    let orientation=sign(dot(transform[0],cofactor[0]));
    let localGeometric=normalize(cofactor*geometric)*orientation;
    let p=(metric*relativeP)/config.base.x;
    let bounds=(abs(metric[0])*material.wearBounds.x+abs(metric[1])*material.wearBounds.y+abs(metric[2])*material.wearBounds.z)/config.base.x;
    var weights=abs(localGeometric);weights=weights*weights;weights=weights*weights;weights/=weights.x+weights.y+weights.z;
    var gradient=vec3f(0);
    for(var axis=0u;axis<3u;axis++) {
      if(weights[axis]>0.0001) {
        let u=select(0u,1u,axis==0u);let v=select(2u,1u,axis==2u);
        let plane=wearProjection(vec2f(p[u],p[v]),vec2f(bounds[u],bounds[v]),p[axis],bounds[axis],material.wearParams[effect],u32(config.base.y)^wearHash(axis+731u),config,effect,0x6725u,0x521bu);
        roughness+=weights[axis]*plane.roughness;
        gradient[u]+=weights[axis]*plane.gradient.x;gradient[v]+=weights[axis]*plane.gradient.y;
      }
    }
    // Chain rule from effect coordinates to world space. Relative relief follows
    // model size; physical relief remains fixed in scene units.
    let baseNormal=normalize(cofactor*shading)*orientation;
    let normalScale=select(length(transpose(relative)*baseNormal),1.0,config.base.z>0.5);
    worldGradient+=transpose(transform)*gradient/max(normalScale,1e-12);
  }
  result.roughness=clamp(result.roughness+roughness,0.0,1.0);
  let tangent=worldGradient-shading*dot(worldGradient,shading);
  let bumped=normalize(shading-tangent);
  if(dot(bumped,geometric)>0.0) {result.normal=bumped;}
  return result;
}
fn wornMaterial(material: Material, position: vec3f, geometric: vec3f) -> Material {
  var result=material;
  result.textureParams.x=dielectricWear(material,position,geometric,geometric).roughness;
  return result;
}
