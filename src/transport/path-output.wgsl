@group(0) @binding(0) var outputImage: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> params: CameraParams;
@group(0) @binding(8) var<storage, read_write> accumulation: array<vec4f>;
override PT_WORKGROUP_X: u32 = 8u;
override PT_WORKGROUP_Y: u32 = 8u;
fn renderPathPixel(id:vec2u,repair:bool) {
  if (any(id >= params.size)) { return; }
  let pixel = id.y * params.size.x + id.x;
  if (params.view == 5u) {
    let stream=select(pixel,0x7370706du,params.padding0==1u);
    let wavelength=sampleWavelength(sample1D(params.frame,2u,stream,params.seed)).wavelength;
    let color=max(xyzToLinearRgb(cieXyz(wavelength)),vec3f(0));
    textureStore(outputImage,vec2i(id),vec4f(color/max(max(color.x,color.y),max(color.z,0.00001)),1));return;
  }
  let jitter = vec2f(sample1D(params.frame, 0u, pixel, params.seed), sample1D(params.frame, 1u, pixel, params.seed));
  let uv = (vec2f(id) + jitter) / vec2f(params.size);
  let p = vec2f(2.0 * uv.x - 1.0, 1.0 - 2.0 * uv.y);
  let direction = normalize(params.forward.xyz + p.x * f32(params.size.x) / f32(params.size.y) * params.right.xyz + p.y * params.up.xyz);
  let ray = Ray(params.eye.xyz, 0.00001, direction, 1e20);
  var result: PathResult;
  if (params.transportMode == 0u) { result = tracePathWithMedia(ray, params.frame, pixel, params.seed, params.maxDepth, params.strategy, params.lightCount,0.0,cameraMedia(params)); }
  else {
    let wavelength=sampleWavelength(sample1D(params.frame,2u,pixel,params.seed));
    result=tracePathWithMedia(ray,params.frame,pixel,params.seed,params.maxDepth,params.strategy,params.lightCount,wavelength.wavelength,cameraMedia(params));
    result.radiance=cieXyz(wavelength.wavelength)*result.radiance.x/(wavelength.pdf*CIE_Y_INTEGRAL);
  }
  if(!PRECISE_TRANSPORT && (result.error==4u || result.error==5u)) {
    accumulation[pixel].w=-(accumulation[pixel].w+1.0);
    enqueueTransportRetry(pixel,params.size.x*params.size.y);
    return;
  }
  if (result.error != 0u) { reportTransportError(select(1u,2u,result.error==4u),5u,pixel,result.interactions,NO_HIT,NO_HIT); textureStore(outputImage, vec2i(id), vec4f(1, 0, 1, 1)); return; }
  var previous=accumulation[pixel];
  if(repair) {previous.w=-previous.w-1.0;}
  let sum = previous + vec4f(result.radiance, 1.0);
  accumulation[pixel] = sum;
  if (params.view == 6u) {
    let t=f32(result.interactions)/f32(params.maxDepth+1u);
    textureStore(outputImage,vec2i(id),vec4f(t,t*t,1.0-t,1));return;
  }
  textureStore(outputImage, vec2i(id), vec4f(sum.xyz / sum.w, 1));
}

@compute @workgroup_size(PT_WORKGROUP_X,PT_WORKGROUP_Y)
fn main(@builtin(global_invocation_id) invocation:vec3u) {
  if(any(invocation.xy>=params.tile.zw)) {return;}
  renderPathPixel(invocation.xy+params.tile.xy,false);
}
@compute @workgroup_size(64)
fn repairMain(@builtin(global_invocation_id) invocation:vec3u) {
  let index=transportRetryIndex(invocation.x,params.size.x*params.size.y);
  if(index==NO_HIT) {return;}
  let id=vec2u(index%params.size.x,index/params.size.x);
  if(any(id>=params.size)) {return;}
  if(accumulation[id.y*params.size.x+id.x].w>=0.0) {return;}
  renderPathPixel(id,true);
}
