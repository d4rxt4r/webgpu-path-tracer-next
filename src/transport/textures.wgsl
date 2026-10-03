// Solid textures are evaluated in object space: no UV seams, no sliding on orbit/transform.
fn textureHash(cell: vec3i) -> f32 {
  let h=hash32((bitcast<u32>(cell.x)*1597334677u) ^ (bitcast<u32>(cell.y)*3812015801u) ^ (bitcast<u32>(cell.z)*2798796415u));
  return f32(h >> 8u) * (1.0 / 16777216.0);
}
fn textureNoise(p: vec3f) -> f32 {
  let cell=vec3i(floor(p)); let f=fract(p); let u=f*f*(3.0-2.0*f);
  return mix(mix(mix(textureHash(cell),textureHash(cell+vec3i(1,0,0)),u.x),
                 mix(textureHash(cell+vec3i(0,1,0)),textureHash(cell+vec3i(1,1,0)),u.x),u.y),
             mix(mix(textureHash(cell+vec3i(0,0,1)),textureHash(cell+vec3i(1,0,1)),u.x),
                 mix(textureHash(cell+vec3i(0,1,1)),textureHash(cell+vec3i(1,1,1)),u.x),u.y),u.z);
}
fn textureFbm(p: vec3f) -> f32 {
  return (textureNoise(p) + 0.5*textureNoise(p*2.03+vec3f(13.1,7.7,3.9)) + 0.25*textureNoise(p*4.11+vec3f(5.2,19.3,11.8))) / 1.75;
}
fn texturePattern(material: Material, position: vec3f) -> f32 {
  let local=(material.worldToTexture*vec4f(position,1)).xyz;
  let p=local*material.textureParams.x;
  let turbulence=material.textureParams.y; let width=material.textureParams.z;
  let noise=textureFbm(p);
  var pattern=0.0;
  if(material.kind==3u) {
    let vein=abs(sin(dot(p,vec3f(1.1,1.8,0.9)) + turbulence*7.0*(noise-0.5)));
    pattern=1.0-smoothstep(width*0.25,width,vein);
  } else if(material.kind==4u) {
    let warped=p+vec3f(turbulence*(noise-0.5));
    let field=abs(textureFbm(warped)-0.5);
    pattern=1.0-smoothstep(width,width+0.075,field);
  }
  return pattern;
}
fn surfaceColor(material: Material, position: vec3f, wavelength: f32) -> vec3f {
  let base=spectralColor(material.color,material.spectrumOffset,wavelength);
  var color=base;
  if(material.kind==3u) {
    color=mix(base,spectralColor(material.absorption,material.absorptionOffset,wavelength),texturePattern(material,position));
  }
  return color;
}
fn surfaceEmission(material: Material, position: vec3f, wavelength: f32) -> vec3f {
  var emission=vec3f(0);
  if(material.kind==1u) {emission=spectralColor(material.color,material.spectrumOffset,wavelength);}
  else if(material.kind==4u) {emission=spectralColor(material.absorption,material.absorptionOffset,wavelength)*material.ior*texturePattern(material,position);}
  return emission;
}
// Energy-conserving mixture of polished reflection and a Lambertian stone base.
// The delta coat is sampled identically by radiance and importance transport.
fn coatingProbability(material: Material) -> f32 {
  var probability=0.0;
  if(material.kind>=3u && material.textureParams.w>0.0) {
    probability=material.textureParams.w;
  }
  return probability;
}
fn coatingDirection(incoming: vec3f, geometric: vec3f, shading: vec3f) -> vec3f {
  var direction=reflect(incoming,shading);
  if(dot(direction,geometric)<=0.0) {direction=reflect(incoming,geometric);}
  return normalize(direction);
}
