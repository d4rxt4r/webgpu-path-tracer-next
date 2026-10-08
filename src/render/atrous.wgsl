struct FilterParams {
 step:u32, strength:f32, filterGlass:u32, spectral:u32,
 algorithm:u32, radius:u32, normalPower:f32, depthScale:f32,
 glassStrength:f32, blend:f32, finalPass:u32, compare:u32,
 split:f32, imageOnly:f32, pad1:f32, pad2:f32
}
@group(0) @binding(0) var inputImage:texture_2d<f32>;
@group(0) @binding(1) var rawImage:texture_2d<f32>;
@group(0) @binding(2) var guides:texture_2d<f32>;
@group(0) @binding(3) var outputImage:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var<uniform> params:FilterParams;
fn luminance(c:vec3f)->f32 {return select(dot(c,vec3f(0.2126,0.7152,0.0722)),c.y,params.spectral!=0u);}
fn color(c:vec3f)->vec3f {
 if(params.spectral==0u) {return c;}
 return vec3f(dot(c,vec3f(3.2406,-1.5372,-0.4986)),dot(c,vec3f(-0.9689,1.8758,0.0415)),dot(c,vec3f(0.0557,-0.2040,1.0570)));
}
fn compatible(a:vec4f,b:vec4f)->bool {return params.imageOnly!=0.0 || a.w*b.w>0.0;}
fn store(p:vec2i,c:vec3f) {
 var result=c;
 if(params.finalPass!=0u) {
  let raw=textureLoad(rawImage,p,0).xyz;
  result=mix(raw,c,params.blend);
  if(params.compare!=0u && f32(p.x)<params.split*f32(textureDimensions(rawImage).x)) {result=raw;}
 }
 textureStore(outputImage,p,vec4f(result,1));
}
@compute @workgroup_size(8,8)
fn filterMain(@builtin(global_invocation_id) id:vec3u) {
  let size=vec2i(textureDimensions(inputImage));let p=vec2i(id.xy);
  if(any(p>=size)) {return;}
  let center=textureLoad(inputImage,p,0);let guide=textureLoad(guides,p,0);
  // The first surface of a refracted path does not describe its visible background.
  if(params.imageOnly==0.0 && (guide.w==0.0||(guide.w<0.0&&params.filterGlass==0u))) {store(p,center.xyz);return;}
  var mean=0.0;var second=0.0;
  for(var y=-1;y<=1;y++) {for(var x=-1;x<=1;x++) {
    let q=clamp(p+vec2i(x,y),vec2i(0),size-1);
    let l=luminance(textureLoad(rawImage,q,0).xyz);mean+=l;second+=l*l;
  }}
  // Local spatial variance estimate; never interpreted as a convergence bound.
  let strength=select(params.strength,params.glassStrength,guide.w<0.0 && params.imageOnly==0.0);
  let sigma=strength*sqrt(max(0.0,second/9.0-mean*mean/81.0))+0.0001;
  let kernel=array<f32,5>(1,4,6,4,1);var sum=vec3f(0);var weights=0.0;
  let centerL=luminance(center.xyz);
  let radius=select(i32(params.radius),2,params.algorithm==0u);
  for(var y=-radius;y<=radius;y++) {for(var x=-radius;x<=radius;x++) {
    let q=p+vec2i(x,y)*select(1,i32(params.step),params.algorithm==0u);
    if(any(q<vec2i(0))||any(q>=size)) {continue;}
    let g=textureLoad(guides,q,0);
    if(params.imageOnly==0.0 && g.w*guide.w<=0.0) {continue;}
    let c=textureLoad(inputImage,q,0).xyz;
    let imageGlass=params.imageOnly!=0.0 || (guide.w<0.0&&params.filterGlass==2u);
    let normalWeight=select(pow(max(0.000001,dot(guide.xyz,g.xyz)),params.normalPower),1.0,imageGlass);
    let depthWeight=select(exp(-abs(abs(g.w)-abs(guide.w))/(params.depthScale*abs(guide.w)*f32(params.step)+0.0001)),1.0,imageGlass);
    var distance=abs(luminance(c)-centerL);
    if(params.algorithm!=0u||imageGlass) {distance=length(color(c)-color(center.xyz))/sqrt(3.0);}
    if(params.algorithm==2u) {
      var patchDistance=0.0;var count=0.0;
      for(var py=-1;py<=1;py++) {for(var px=-1;px<=1;px++) {
        let a=clamp(p+vec2i(px,py),vec2i(0),size-1);
        let b=clamp(q+vec2i(px,py),vec2i(0),size-1);
        if(!compatible(textureLoad(guides,a,0),textureLoad(guides,b,0))) {continue;}
        let delta=color(textureLoad(rawImage,a,0).xyz)-color(textureLoad(rawImage,b,0).xyz);
        patchDistance+=dot(delta,delta)/3.0;count+=1.0;
      }}
      distance=sqrt(patchDistance/max(count,1.0));
    }
    let colorWeight=exp(-distance/sigma);
    var spatial=exp(-f32(x*x+y*y)/max(1.0,f32(radius*radius)));
    if(params.algorithm==0u) {spatial=kernel[u32(x+2)]*kernel[u32(y+2)];}
    let w=spatial*normalWeight*depthWeight*colorWeight;
    sum+=w*c;weights+=w;
  }}
  store(p,sum/max(weights,0.000001));
}
