const NO_HIT: u32 = 0xffffffffu;
const FAR: f32 = 1e30;
const STACK_SIZE: u32 = 64u;
@group(0) @binding(2) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(3) var<storage, read> triangles: array<Triangle>;

fn miss(ray: Ray) -> Hit { return Hit(ray.tMax, NO_HIT, 0, 0, NO_HIT, 0, 0, 0); }
fn failHit(ray: Ray, code: u32, visits: u32) -> Hit { var h = miss(ray); h.error = code; h.visits = visits; return h; }

fn boundsNear(ray: Ray, node: BvhNode, limit: f32) -> f32 {
  var near = ray.tMin;
  var far = limit;
  for (var axis = 0u; axis < 3u; axis++) {
    if (ray.direction[axis] == 0.0) {
      if (ray.origin[axis] < node.min[axis] || ray.origin[axis] > node.max[axis]) { return FAR; }
    } else {
      let a = (node.min[axis] - ray.origin[axis]) / ray.direction[axis];
      let b = (node.max[axis] - ray.origin[axis]) / ray.direction[axis];
      near = max(near, min(a, b)); far = min(far, max(a, b));
      if (near > far) { return FAR; }
    }
  }
  return near;
}

fn triangleHit(ray: Ray, tri: Triangle) -> Hit {
  if (!all(abs(tri.a) < vec3f(FAR)) || !all(abs(tri.b) < vec3f(FAR)) || !all(abs(tri.c) < vec3f(FAR))) { return failHit(ray, 3u, 0u); }
  var kz = 0u;
  if (abs(ray.direction.y) > abs(ray.direction[kz])) { kz = 1u; }
  if (abs(ray.direction.z) > abs(ray.direction[kz])) { kz = 2u; }
  if (ray.direction[kz] == 0.0) { return miss(ray); }
  var kx = (kz + 1u) % 3u;
  var ky = (kx + 1u) % 3u;
  if (ray.direction[kz] < 0.0) { let swap = kx; kx = ky; ky = swap; }
  let sx = -ray.direction[kx] / ray.direction[kz];
  let sy = -ray.direction[ky] / ray.direction[kz];
  let sz = 1.0 / ray.direction[kz];
  let a = tri.a - ray.origin; let b = tri.b - ray.origin; let c = tri.c - ray.origin;
  let ap = vec3f(a[kx] + sx * a[kz], a[ky] + sy * a[kz], a[kz] * sz);
  let bp = vec3f(b[kx] + sx * b[kz], b[ky] + sy * b[kz], b[kz] * sz);
  let cp = vec3f(c[kx] + sx * c[kz], c[ky] + sy * c[kz], c[kz] * sz);
  let e0 = bp.x * cp.y - bp.y * cp.x;
  let e1 = cp.x * ap.y - cp.y * ap.x;
  let e2 = ap.x * bp.y - ap.y * bp.x;
  if (!all(abs(vec3f(e0, e1, e2)) < vec3f(FAR))) { return failHit(ray, 3u, 0u); }
  if ((e0 < 0.0 || e1 < 0.0 || e2 < 0.0) && (e0 > 0.0 || e1 > 0.0 || e2 > 0.0)) { return miss(ray); }
  let det = e0 + e1 + e2;
  if (det == 0.0) { return miss(ray); }
  let t = (e0 * ap.z + e1 * bp.z + e2 * cp.z) / det;
  if (t < ray.tMin || t > ray.tMax) { return miss(ray); }
  if (!(abs(t) < FAR)) { return failHit(ray, 3u, 0u); }
  return Hit(t, tri.id, e1 / det, e2 / det, NO_HIT, 0, 0, 0);
}

fn traceBvh(ray: Ray, stopAtFirst: bool) -> Hit {
  if (!all(abs(ray.origin) < vec3f(FAR)) || !all(abs(ray.direction) < vec3f(FAR)) || dot(ray.direction, ray.direction) == 0.0 || !(ray.tMin >= 0.0 && ray.tMax >= ray.tMin && ray.tMax < FAR)) { return failHit(ray, 3u, 0u); }
  var stack: array<u32, 64>;
  stack[0] = 0u;
  var size = 1u;
  var best = miss(ray);
  var visits = 0u;
  loop {
    if (size == 0u) { break; }
    size--;
    let index = stack[size];
    visits++;
    if (index >= arrayLength(&nodes) || visits > arrayLength(&nodes)) { return failHit(ray, 1u, visits); }
    let node = nodes[index];
    if (!all(abs(node.min) < vec3f(FAR)) || !all(abs(node.max) < vec3f(FAR)) || any(node.min > node.max)) { return failHit(ray, 3u, visits); }
    if (boundsNear(ray, node, best.t) == FAR) { continue; }
    if (node.count > 0u) {
      if (node.first >= arrayLength(&triangles) || node.count > arrayLength(&triangles) - node.first) { return failHit(ray, 1u, visits); }
      for (var i = node.first; i < node.first + node.count; i++) {
        var bounded = ray; bounded.tMax = best.t;
        var hit = triangleHit(bounded, triangles[i]);
        if (hit.error != 0u) { return failHit(ray, hit.error, visits); }
        if (hit.id != NO_HIT && (best.id == NO_HIT || hit.t < best.t || (hit.t == best.t && hit.id < best.id))) {
          hit.triangle = i; best = hit;
          if (stopAtFirst) { best.visits = visits; return best; }
        }
      }
    } else {
      if (node.first >= arrayLength(&nodes) - 1u) { return failHit(ray, 1u, visits); }
      let left = boundsNear(ray, nodes[node.first], best.t);
      let right = boundsNear(ray, nodes[node.first + 1u], best.t);
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
fn closestHit(ray: Ray) -> Hit { return traceBvh(ray, false); }
fn anyHit(ray: Ray) -> Hit { return traceBvh(ray, true); }

fn geometricNormal(triangle: Triangle) -> vec3f { return normalize(cross(triangle.b - triangle.a, triangle.c - triangle.a)); }
fn shadingNormal(triangle: Triangle, hit: Hit) -> vec3f { return normalize((1.0 - hit.u - hit.v) * triangle.na + hit.u * triangle.nb + hit.v * triangle.nc); }
fn surfacePosition(triangle: Triangle, hit: Hit) -> vec3f {
  return (1.0-hit.u-hit.v)*triangle.a + hit.u*triangle.b + hit.v*triangle.c;
}
// Bound interpolation roundoff rather than moving every hit by a fixed world epsilon.
// A large fixed offset can jump across a nearby boundary in a narrow glass fold.
fn offsetSurface(triangle: Triangle, hit: Hit, direction: vec3f) -> vec3f {
  let position=surfacePosition(triangle,hit);let normal=geometricNormal(triangle);
  let pError=8.344657e-7*(abs(1.0-hit.u-hit.v)*abs(triangle.a)+abs(hit.u)*abs(triangle.b)+abs(hit.v)*abs(triangle.c));
  // The sheared intersection also loses precision on large triangles near zero.
  let edges=max(abs(triangle.b-triangle.a),abs(triangle.c-triangle.a));
  let intersectionError=8.344657e-7*max(edges.x,max(edges.y,edges.z));
  let distance=max(dot(abs(normal),pError)+intersectionError,1e-7);
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
