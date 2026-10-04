const NO_HIT: u32 = 0xffffffffu;
const FAR: f32 = 1e30;
const STACK_SIZE: u32 = 64u;
@group(0) @binding(2) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(3) var<storage, read> triangles: array<Triangle>;

fn miss(ray: Ray) -> Hit { return Hit(ray.tMax, NO_HIT, 0, 0, NO_HIT, 0, 0, 0); }
fn failHit(ray: Ray, code: u32, visits: u32) -> Hit { var h = miss(ray); h.error = code; h.visits = visits; return h; }

fn boundsNearPrepared(ray: Ray, node: BvhNode, limit: f32, reciprocal: vec3f) -> f32 {
  var near = ray.tMin;
  var far = limit;
  for (var axis = 0u; axis < 3u; axis++) {
    if (ray.direction[axis] == 0.0) {
      if (ray.origin[axis] < node.min[axis] || ray.origin[axis] > node.max[axis]) { return FAR; }
    } else {
      let a = (node.min[axis] - ray.origin[axis]) * reciprocal[axis];
      let b = (node.max[axis] - ray.origin[axis]) * reciprocal[axis];
      near = max(near, min(a, b)); far = min(far, max(a, b));
      if (near > far) { return FAR; }
    }
  }
  return near;
}

fn boundsNear(ray: Ray, node: BvhNode, limit: f32) -> f32 { return boundsNearPrepared(ray, node, limit, 1.0 / ray.direction); }

struct RayShear { axes: vec3u, scale: vec3f, coordinateError:f32 }
fn rayShear(direction: vec3f) -> RayShear {
  var kz = 0u;
  if (abs(direction.y) > abs(direction[kz])) { kz = 1u; }
  if (abs(direction.z) > abs(direction[kz])) { kz = 2u; }
  var kx = (kz + 1u) % 3u;
  var ky = (kx + 1u) % 3u;
  if (direction[kz] < 0.0) { let swap = kx; kx = ky; ky = swap; }
  return RayShear(vec3u(kx, ky, kz), vec3f(-direction[kx] / direction[kz], -direction[ky] / direction[kz], 1.0 / direction[kz]),0.0);
}
fn triangleHitPrepared(ray: Ray, tri: Triangle, shear: RayShear, originLow:vec3f) -> Hit {
  if (!all(abs(tri.a) < vec3f(FAR)) || !all(abs(tri.b) < vec3f(FAR)) || !all(abs(tri.c) < vec3f(FAR))) { return failHit(ray, 3u, 0u); }
  let kx = shear.axes.x; let ky = shear.axes.y; let kz = shear.axes.z;
  let sx = shear.scale.x; let sy = shear.scale.y; let sz = shear.scale.z;
  var a = tri.a - ray.origin; var b = tri.b - ray.origin; var c = tri.c - ray.origin;
  if(PRECISE_TRANSPORT) {
    a-=originLow;b-=originLow;c-=originLow;
  }
  let ap = vec3f(a[kx] + sx * a[kz], a[ky] + sy * a[kz], a[kz] * sz);
  let bp = vec3f(b[kx] + sx * b[kz], b[ky] + sy * b[kz], b[kz] * sz);
  let cp = vec3f(c[kx] + sx * c[kz], c[ky] + sy * c[kz], c[kz] * sz);
  let e0 = bp.x * cp.y - bp.y * cp.x;
  let e1 = cp.x * ap.y - cp.y * ap.x;
  let e2 = ap.x * bp.y - ap.y * bp.x;
  if (!all(abs(vec3f(e0, e1, e2)) < vec3f(FAR))) { return failHit(ray, 3u, 0u); }
  // Bound translation/shear error before deciding edge signs. A barycentric
  // threshold alone misses skinny triangles and cancellation far from the eye.
  // gamma(9) covers subtraction, the <=2.5-ULP division, product and sum;
  // four coordinate/product terms propagate it into each edge determinant.
  var coordinateError=shear.coordinateError;
  if(PRECISE_TRANSPORT) {
    let translated=max(abs(a),max(abs(b),abs(c)));
    coordinateError=5.960468e-7*max(translated.x,max(translated.y,translated.z))*(1.0+max(abs(sx),abs(sy)));
  }
  let projected=max(abs(ap.xy),max(abs(bp.xy),abs(cp.xy)));
  let edgeError=4.0*coordinateError*max(projected.x,projected.y)+2.0*coordinateError*coordinateError+3.5762793e-7*projected.x*projected.y;
  if(min(abs(e0),min(abs(e1),abs(e2)))<=edgeError) {
    if(PRECISE_TRANSPORT) {return preciseTriangleHit(ray,tri,originLow);}
    return failHit(ray,5u,0u);
  }
  if ((e0 < 0.0 || e1 < 0.0 || e2 < 0.0) && (e0 > 0.0 || e1 > 0.0 || e2 > 0.0)) {
    return miss(ray);
  }
  let det = e0 + e1 + e2;
  if (det == 0.0) { return miss(ray); }
  if(PRECISE_TRANSPORT && any(originLow!=vec3f(0))) {
    let distance=precisePlaneDistance(ray,tri,originLow);
    if(dsNegative(dsSub(distance,vec2f(ray.tMin,0))) || dsNegative(dsSub(vec2f(ray.tMax,0),distance))) {return miss(ray);}
    return Hit(distance.x,tri.id,e1/det,e2/det,NO_HIT,0u,0u,bitcast<u32>(distance.y));
  }
  let t = (e0 * ap.z + e1 * bp.z + e2 * cp.z) / det;
  if (t < ray.tMin || t > ray.tMax) { return miss(ray); }
  if (!(abs(t) < FAR)) { return failHit(ray, 3u, 0u); }
  let u=e1/det;let v=e2/det;
  return Hit(t, tri.id, u, v, NO_HIT, 0, 0, 0);
}
fn triangleHit(ray: Ray, tri: Triangle) -> Hit {
  if (all(ray.direction == vec3f(0))) { return miss(ray); }
  return triangleHitPrepared(ray, tri, rayShear(ray.direction),vec3f(0));
}
fn hitDistanceLimit(hit:Hit)->f32 {
  return select(hit.t,bitcast<f32>(bitcast<u32>(hit.t)+16u),hit.id!=NO_HIT);
}

fn traceBvh(ray: Ray, stopAtFirst: bool, originLow:vec3f) -> Hit {
  if (!all(abs(ray.origin) < vec3f(FAR)) || !all(abs(ray.direction) < vec3f(FAR)) || dot(ray.direction, ray.direction) == 0.0 || !(ray.tMin >= 0.0 && ray.tMax >= ray.tMin && ray.tMax < FAR)) { return failHit(ray, 3u, 0u); }
  var stack: array<u32, 64>;
  stack[0] = 0u;
  var size = 1u;
  var best = miss(ray);
  var limit=ray.tMax;
  var visits = 0u;
  var shear = rayShear(ray.direction);
  if(!PRECISE_TRANSPORT) {
    // The root encloses every float32 vertex. Bound translation and shear once
    // per ray, instead of rebuilding the bound for every visited triangle.
    let extent=max(abs(nodes[0].min-ray.origin),abs(nodes[0].max-ray.origin));
    shear.coordinateError=5.364421e-7*max(extent.x,max(extent.y,extent.z))*(1.0+max(abs(shear.scale.x),abs(shear.scale.y)));
  }
  let reciprocal = 1.0 / ray.direction;
  loop {
    if (size == 0u) { break; }
    size--;
    let index = stack[size];
    visits++;
    if (index >= arrayLength(&nodes) || visits > arrayLength(&nodes)) { return failHit(ray, 1u, visits); }
    let node = nodes[index];
    if (!all(abs(node.min) < vec3f(FAR)) || !all(abs(node.max) < vec3f(FAR)) || any(node.min > node.max)) { return failHit(ray, 3u, visits); }
    if (boundsNearPrepared(ray, node, limit, reciprocal) == FAR) { continue; }
    if (node.count > 0u) {
      if (node.first >= arrayLength(&triangles) || node.count > arrayLength(&triangles) - node.first) { return failHit(ray, 1u, visits); }
      for (var i = node.first; i < node.first + node.count; i++) {
        var bounded = ray; bounded.tMax = limit;
        var hit = triangleHitPrepared(bounded, triangles[i], shear,originLow);
        if (hit.error != 0u) { return failHit(ray, hit.error, visits); }
        var closer=hit.t<best.t;
        if(hit.id!=NO_HIT && best.id!=NO_HIT && abs(i32(bitcast<u32>(hit.t))-i32(bitcast<u32>(best.t)))<=16) {
          if(!PRECISE_TRANSPORT) {return failHit(ray,5u,visits);}
          hit=preciseTriangleHit(bounded,triangles[i],originLow);
          let refined=preciseTriangleHit(bounded,triangles[best.triangle],originLow);
          if(refined.id!=NO_HIT) {var updated=refined;updated.triangle=best.triangle;best=updated;limit=min(ray.tMax,hitDistanceLimit(best));}
          closer=hit.t<best.t || (hit.t==best.t && bitcast<f32>(hit.padding)<bitcast<f32>(best.padding));
        }
        if (hit.id != NO_HIT && (best.id == NO_HIT || closer || (hit.t == best.t && bitcast<f32>(hit.padding)==bitcast<f32>(best.padding) && hit.id < best.id))) {
          hit.triangle = i; best = hit;limit=min(ray.tMax,hitDistanceLimit(best));
          if (stopAtFirst) { best.visits = visits; return best; }
        }
      }
    } else {
      if (node.first >= arrayLength(&nodes) - 1u) { return failHit(ray, 1u, visits); }
      let left = boundsNearPrepared(ray, nodes[node.first], limit, reciprocal);
      let right = boundsNearPrepared(ray, nodes[node.first + 1u], limit, reciprocal);
      let count = u32(left != FAR) + u32(right != FAR);
      if (size + count > STACK_SIZE) { return failHit(ray, 2u, visits); }
      if (left != FAR && right != FAR) {
        stack[size] = select(node.first, node.first + 1u, left <= right);
        stack[size + 1u] = select(node.first + 1u, node.first, left <= right); size += 2u;
      } else if (left != FAR) { stack[size] = node.first; size++; }
      else if (right != FAR) { stack[size] = node.first + 1u; size++; }
    }
  }
  best.visits = visits;
  return best;
}
fn closestHit(ray: Ray) -> Hit { return traceBvh(ray, false,vec3f(0)); }
fn closestHitWithOrigin(ray: Ray,originLow:vec3f) -> Hit { return traceBvh(ray, false,originLow); }
fn anyHit(ray: Ray) -> Hit { return traceBvh(ray, true,vec3f(0)); }

fn geometricNormal(triangle: Triangle) -> vec3f { return normalize(cross(triangle.b - triangle.a, triangle.c - triangle.a)); }
fn shadingNormal(triangle: Triangle, hit: Hit) -> vec3f { return normalize((1.0 - hit.u - hit.v) * triangle.na + hit.u * triangle.nb + hit.v * triangle.nc); }
fn surfacePosition(triangle: Triangle, hit: Hit) -> vec3f {
  // Add the base vertex last: its rounding error must not be multiplied by
  // three independently rounded barycentric weights near a shared edge.
  return triangle.a + fma(vec3f(hit.u),triangle.b-triangle.a,vec3f(hit.v)*(triangle.c-triangle.a));
}
// Bound interpolation roundoff rather than moving every hit by a fixed world epsilon.
// A large fixed offset can jump across a nearby boundary in a narrow glass fold.
fn offsetSurface(triangle: Triangle, hit: Hit, direction: vec3f) -> vec3f {
  let position=surfacePosition(triangle,hit);let normal=geometricNormal(triangle);
  // Unit roundoff and gamma(3) bound the subtraction, product and FMA
  // reconstruction, including a non-fused lowering of fma. Barycentric error
  // moves along the plane; include an extent term for the sheared intersection.
  let unitRoundoff=5.960464477539063e-8;
  let gamma3=1.788139663006007e-7;
  let e1=triangle.b-triangle.a;let e2=triangle.c-triangle.a;
  let edgeError=unitRoundoff*(abs(hit.u)*(abs(triangle.b)+abs(triangle.a))+abs(hit.v)*(abs(triangle.c)+abs(triangle.a)));
  let pError=edgeError+gamma3*(abs(hit.u*e1)+abs(hit.v*e2))+unitRoundoff*abs(position);
  let edges=max(abs(e1),abs(e2));
  let intersectionError=gamma3*max(edges.x,max(edges.y,edges.z));
  let distance=dot(abs(normal),pError)+intersectionError;
  let offset=select(-distance,distance,dot(normal,direction)>=0.0)*normal;
  var origin=position+offset;
  // Round away from the surface even when a component is below one local ULP.
  for(var axis=0u;axis<3u;axis++) {
    if(offset[axis]!=0.0 && origin[axis]!=0.0) {
      let positive=offset[axis]>0.0;
      let step=select(-1,1,positive==(origin[axis]>0.0));
      origin[axis]=bitcast<f32>(bitcast<i32>(origin[axis])+step);
    }
  }
  return origin;
}
// Conservative world-space error offset; geometric normal defines the side.
fn offsetOrigin(position: vec3f, normal: vec3f, direction: vec3f) -> vec3f {
  let error = 4e-6 * max(1.0, max(abs(position.x), max(abs(position.y), abs(position.z))));
  return position + select(-error, error, dot(normal, direction) >= 0.0) * normal;
}

// Reconstructing an f32 origin close to a crease can cross another face even
// when its displacement is safe for the current plane. Replay before spawning.
fn needsPreciseOrigin(ray:Ray,tri:Triangle,hit:Hit)->bool {
  let e1=tri.b-tri.a;let e2=tri.c-tri.a;
  let e3=e1-e2;let area=cross(e1,e2);
  let edgeSquared=max(dot(e1,e1),max(dot(e2,e2),dot(e3,e3)));
  let extent=max(abs(e1),max(abs(e2),abs(e3)));
  // sqrt(3)*the largest component bounds edge length without a square root.
  let edge=1.732051*max(extent.x,max(extent.y,extent.z));
  let coordinate=max(abs(tri.a),max(abs(tri.b),abs(tri.c)));
  let direction=abs(ray.direction);
  let magnitude=max(coordinate.x,max(coordinate.y,coordinate.z))+abs(hit.t)*max(direction.x,max(direction.y,direction.z))+edge;
  let error=1.9073523e-6*magnitude; // gamma(32), with no fixed world-scale floor
  let margin=min(hit.u,min(hit.v,1.0-hit.u-hit.v));
  return !(margin>0.0 && margin*margin*dot(area,area)>error*error*edgeSquared);
}
