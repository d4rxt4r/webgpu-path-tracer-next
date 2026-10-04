// Escape links occupy the unused normal padding of the triangle buffer.
fn traceBvh(ray:Ray,stopAtFirst:bool)->Hit {
 if (!all(abs(ray.origin)<vec3f(FAR)) || !all(abs(ray.direction)<vec3f(FAR)) || dot(ray.direction,ray.direction)==0.0 || !(ray.tMin>=0.0 && ray.tMax>=ray.tMin && ray.tMax<FAR)) {return failHit(ray,3u,0u);}
 var best=miss(ray);var limit=ray.tMax;var visits=0u;var index=0u;
 var shear=rayShear(ray.direction);let extent=max(abs(nodes[0].min-ray.origin),abs(nodes[0].max-ray.origin));
 shear.coordinateError=5.364421e-7*max(extent.x,max(extent.y,extent.z))*(1.0+max(abs(shear.scale.x),abs(shear.scale.y)));
 let reciprocal=1.0/ray.direction;
 while(index!=NO_HIT) {
  if(index>=arrayLength(&nodes) || visits>=arrayLength(&nodes)) {return failHit(ray,1u,visits);}
  visits++;let node=nodes[index];
  if(!all(abs(node.min)<vec3f(FAR)) || !all(abs(node.max)<vec3f(FAR)) || any(node.min>node.max)) {return failHit(ray,3u,visits);}
  if(index/2u>=arrayLength(&triangles)) {return failHit(ray,1u,visits);}
  let links=triangles[index/2u];let escape=select(links.padding1,links.padding2,(index&1u)!=0u);
  if(boundsNearPrepared(ray,node,limit,reciprocal)==FAR) {index=escape;continue;}
  if(node.count>0u) {
   if(node.first>=arrayLength(&triangles) || node.count>arrayLength(&triangles)-node.first) {return failHit(ray,1u,visits);}
   for(var i=node.first;i<node.first+node.count;i++) {
    var bounded=ray;bounded.tMax=limit;var hit=triangleHitPrepared(bounded,triangles[i],shear);
    if(hit.error!=0u) {return failHit(ray,hit.error,visits);}
    if(hit.id!=NO_HIT && best.id!=NO_HIT && abs(i32(bitcast<u32>(hit.t))-i32(bitcast<u32>(best.t)))<=16) {return failHit(ray,5u,visits);}
    if(hit.id!=NO_HIT && (best.id==NO_HIT || hit.t<best.t || (hit.t==best.t && hit.id<best.id))) {
     hit.triangle=i;best=hit;limit=min(ray.tMax,hitDistanceLimit(best));
     if(stopAtFirst) {best.visits=visits;return best;}
    }
   }
   index=escape;
  } else {
   if(node.first>=arrayLength(&nodes)-1u) {return failHit(ray,1u,visits);}
   index=node.first;
  }
 }
 best.visits=visits;return best;
}
