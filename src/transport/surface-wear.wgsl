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
// gradient.xy is the analytic gradient of a small height field. All marks have
// smooth edges, and scratches fit within their cells, including their end caps.
struct WearPlane { roughness: f32, gradient: vec2f }
fn wearPlane(uv: vec2f, bounds: vec2f, controls: vec3f, seed: u32) -> WearPlane {
  var result=WearPlane(0.0,vec2f(0));
  if(controls.x>0.0) {
    let grid=uv*12.0;let cell=vec2i(floor(grid));let p=fract(grid)-0.5;
    let key=(bitcast<u32>(cell.x)*1597334677u)^(bitcast<u32>(cell.y)*3812015801u)^seed;
    if(wearRandom(key)<0.55) {
      let angle=6.2831853*wearRandom(key^0x1a25u);let axis=vec2f(cos(angle),sin(angle));
      let center=0.16*(vec2f(wearRandom(key^0x235bu),wearRandom(key^0x693du))-0.5);
      let halfLength=0.12+0.20*wearRandom(key^0xa521u);let delta=p-center;
      let d=delta-axis*clamp(dot(delta,axis),-halfLength,halfLength);
      let width=0.012+0.012*wearRandom(key^0x3321u);let inverseWidth=1.0/(width*width);
      let ridge=exp(-dot(d,d)*inverseWidth);
      result.roughness+=controls.x*0.35*ridge;
      result.gradient+=controls.x*0.000012*ridge*2.0*d*inverseWidth*12.0;
    }
  }
  if(controls.y>0.0) {
    let field=wearNoise(uv*7.0,seed^0x432bu);
    let abrasion=smoothstep(0.48,0.78,field);
    let grain=wearNoise(uv*110.0,seed^0x7543u);
    result.roughness+=controls.y*abrasion*(0.12+0.18*grain);
    // Small directional abrasions; no displacement of the geometric boundary.
    result.gradient+=controls.y*abrasion*0.008*vec2f(sin(uv.x*440.0+field*9.0),sin(uv.y*390.0+field*11.0));
  }
  if(controls.z>0.0) {
    for(var i=0u;i<3u;i++) {
      let key=seed^wearHash(i+137u);
      let center=(vec2f(wearRandom(key),wearRandom(key^0x873bu))-0.5)*bounds*1.3;
      let angle=(wearRandom(key^0x9a23u)-0.5)*3.0;let axis=vec2f(cos(angle),sin(angle));
      let delta=uv-center;let p=vec2f(dot(delta,axis),dot(delta,vec2f(-axis.y,axis.x)));
      let radius=vec2f(0.065,0.095)*(0.8+0.4*wearRandom(key^0x342bu));
      let ellipse=p/radius;let envelope=1.0-smoothstep(0.65,1.0,dot(ellipse,ellipse));
      if(envelope>0.0) {
        // Off-centre curved ridges, clipped to an oval and partly rubbed away.
        let curve=length(vec2f(p.x,p.y*0.8+0.03))+0.002*sin(p.y*70.0);
        let ridges=smoothstep(0.05,0.65,cos(curve*1047.1976));
        let rubbed=smoothstep(0.2,0.6,wearNoise(p*65.0,key^0x2547u));
        result.roughness+=controls.z*envelope*rubbed*(0.035+0.22*ridges);
      }
    }
  }
  return result;
}
struct WearSurface { roughness: f32, normal: vec3f }
fn wearProjection(uv: vec2f, bounds: vec2f, depth: f32, halfDepth: f32, controls: vec3f, seed: u32, back: u32, front: u32) -> WearPlane {
  // Position selects the side even for an inward-facing gathering normal.
  // Blend across the centre plane so concave meshes cannot acquire a seam.
  let width=max(halfDepth*0.05,0.0001);
  let weight=smoothstep(-width,width,depth);
  var result=WearPlane(0.0,vec2f(0));
  for(var side=0u;side<2u;side++) {
    let fraction=select(1.0-weight,weight,side==1u);
    if(fraction>0.0001) {
      let plane=wearPlane(uv,bounds,controls,seed^select(back,front,side==1u));
      result.roughness+=fraction*plane.roughness;result.gradient+=fraction*plane.gradient;
    }
  }
  return result;
}
fn dielectricWear(material: Material, position: vec3f, geometric: vec3f, shading: vec3f) -> WearSurface {
  var result=WearSurface(material.textureParams.x,shading);
  if((material.kind!=2u && material.kind!=5u) || !any(material.wearParams.xyz>vec3f(0))) {return result;}
  let transform=mat3x3f(material.worldToTexture[0].xyz,material.worldToTexture[1].xyz,material.worldToTexture[2].xyz);
  let cofactor=mat3x3f(cross(transform[1],transform[2]),cross(transform[2],transform[0]),cross(transform[0],transform[1]));
  let orientation=sign(dot(transform[0],cofactor[0]));
  let localGeometric=normalize(cofactor*geometric)*orientation;
  let localShading=normalize(cofactor*shading)*orientation;
  let p=(material.worldToTexture*vec4f(position,1)).xyz;
  var weights=abs(localGeometric);weights=weights*weights;weights=weights*weights;
  weights/=weights.x+weights.y+weights.z;
  let seed=u32(material.wearParams.w);var gradient=vec3f(0);var roughness=0.0;
  // One loop body keeps driver compilation small. On a planar face only its
  // dominant projection runs; smoothly curved faces blend the projections.
  for(var axis=0u;axis<3u;axis++) {
    if(weights[axis]>0.0001) {
      let u=select(0u,1u,axis==0u);let v=select(2u,1u,axis==2u);
      let bounds=vec2f(material.wearBounds[u],material.wearBounds[v]);
      let plane=wearProjection(vec2f(p[u],p[v]),bounds,p[axis],material.wearBounds[axis],material.wearParams.xyz,seed^wearHash(axis+731u),0x6725u,0x521bu);
      roughness+=weights[axis]*plane.roughness;
      gradient[u]+=weights[axis]*plane.gradient.x;gradient[v]+=weights[axis]*plane.gradient.y;
    }
  }
  result.roughness=clamp(result.roughness+roughness,0.0,1.0);
  let tangentGradient=gradient-localShading*dot(gradient,localShading);
  let bumped=normalize(transpose(transform)*(localShading-tangentGradient));
  if(dot(bumped,geometric)>0.0) {result.normal=bumped;}
  return result;
}
fn wornMaterial(material: Material, position: vec3f, geometric: vec3f) -> Material {
  var result=material;
  result.textureParams.x=dielectricWear(material,position,geometric,geometric).roughness;
  return result;
}
