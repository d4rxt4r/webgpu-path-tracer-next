struct FilterParams { step:u32, strength:f32, filterGlass:u32, spectral:u32 }
@group(0) @binding(0) var inputImage:texture_2d<f32>;
@group(0) @binding(1) var rawImage:texture_2d<f32>;
@group(0) @binding(2) var guides:texture_2d<f32>;
@group(0) @binding(3) var outputImage:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var<uniform> params:FilterParams;
fn luminance(c:vec3f)->f32 {return select(dot(c,vec3f(0.2126,0.7152,0.0722)),c.y,params.spectral!=0u);}
@compute @workgroup_size(8,8)
fn filterMain(@builtin(global_invocation_id) id:vec3u) {
  let size=vec2i(textureDimensions(inputImage));let p=vec2i(id.xy);
  if(any(p>=size)) {return;}
  let center=textureLoad(inputImage,p,0);let guide=textureLoad(guides,p,0);
  // The first surface of a refracted path does not describe its visible background.
  if(guide.w==0.0||(guide.w<0.0&&params.filterGlass==0u)) {textureStore(outputImage,p,center);return;}
  var mean=0.0;var second=0.0;
  for(var y=-1;y<=1;y++) {for(var x=-1;x<=1;x++) {
    let q=clamp(p+vec2i(x,y),vec2i(0),size-1);
    let l=luminance(textureLoad(rawImage,q,0).xyz);mean+=l;second+=l*l;
  }}
  // Local spatial variance estimate; never interpreted as a convergence bound.
  let sigma=params.strength*sqrt(max(0.0,second/9.0-mean*mean/81.0))+0.0001;
  let kernel=array<f32,5>(1,4,6,4,1);var sum=vec3f(0);var weights=0.0;
  let centerL=luminance(center.xyz);
  for(var y=-2;y<=2;y++) {for(var x=-2;x<=2;x++) {
    let q=p+vec2i(x,y)*i32(params.step);
    if(any(q<vec2i(0))||any(q>=size)) {continue;}
    let g=textureLoad(guides,q,0);
    if(g.w*guide.w<=0.0) {continue;}
    let c=textureLoad(inputImage,q,0).xyz;
    let normalWeight=pow(max(0.0,dot(guide.xyz,g.xyz)),32.0);
    let depthWeight=exp(-abs(abs(g.w)-abs(guide.w))/(0.015*abs(guide.w)*f32(params.step)+0.0001));
    let colorWeight=exp(-abs(luminance(c)-centerL)/sigma);
    let w=kernel[u32(x+2)]*kernel[u32(y+2)]*normalWeight*depthWeight*colorWeight;
    sum+=w*c;weights+=w;
  }}
  textureStore(outputImage,p,vec4f(sum/max(weights,0.000001),1));
}
