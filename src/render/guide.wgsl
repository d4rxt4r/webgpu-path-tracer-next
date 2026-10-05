@group(0) @binding(0) var guides: texture_storage_2d<rgba32float, write>;
@group(0) @binding(1) var<uniform> params: CameraParams;
@group(0) @binding(4) var<storage, read_write> traversalErrors: atomic<u32>;
@group(0) @binding(5) var<storage, read> materials: array<Material>;
@compute @workgroup_size(8,8)
fn guideMain(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=params.size)) {return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(params.size);
  let p=vec2f(2.0*uv.x-1.0,1.0-2.0*uv.y);
  let direction=normalize(params.forward.xyz+p.x*f32(params.size.x)/f32(params.size.y)*params.right.xyz+p.y*params.up.xyz);
  let hit=closestHit(Ray(params.eye.xyz,0.00001,direction,1e20));
  var value=vec4f(0);
  if(hit.error!=0u) {atomicAdd(&traversalErrors,1u);}
  else if(hit.id!=NO_HIT) {
    let triangle=triangles[hit.triangle];
    let kind=materials[triangle.material].kind;
    let depth=select(hit.t,-hit.t,kind==2u||kind==5u);
    value=vec4f(shadingNormal(triangle,hit),depth);
  }
  textureStore(guides,vec2i(id.xy),value);
}
