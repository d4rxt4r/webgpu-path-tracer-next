// Independent shells, removed by identity rather than by stack order.
// Entries are representative triangle indices in the packed BVH.
struct MediumSet { entries: array<u32,32>, windings: array<i32,32>, count: u32, error: u32 }
fn activeMedium(state: MediumSet) -> u32 {
  if(state.count==0u) {return NO_HIT;}
  return state.entries[state.count-1u];
}
fn changeMedium(state: MediumSet, triangleIndex: u32, entering: bool) -> MediumSet {
  var next=state;
  let boundary=triangles[triangleIndex].padding0;
  var found=32u;
  for(var i=0u;i<state.count;i++) {
    if(triangles[state.entries[i]].padding0==boundary) {found=i;break;}
  }
  // Nonzero signed winding defines the occupied regions of a closed shell,
  // including folds that cross themselves. Preserve independent shell identity.
  let delta=select(-1,1,entering);
  if(found==32u) {
    if(state.count==32u) {next.error=4u;return next;}
    next.entries[next.count]=triangleIndex;next.windings[next.count]=delta;next.count++;
  } else {
    next.windings[found]+=delta;
    if(next.windings[found]==0) {
      for(var i=found;i+1u<next.count;i++) {
        next.entries[i]=next.entries[i+1u];next.windings[i]=next.windings[i+1u];
      }
      next.count--;
    }
  }
  return next;
}
fn mediumIor(state: MediumSet, wavelength:f32) -> f32 {
  let index=activeMedium(state);
  if(index==NO_HIT) {return 1.0;}
  return materialIor(materials[triangles[index].material],wavelength);
}
fn changeMediumAtSurface(state:MediumSet,ray:Ray,originLow:vec3f,hit:Hit)->MediumSet {
  let triangle=triangles[hit.triangle];
  var next=changeMedium(state,hit.triangle,dot(geometricNormal(triangle),ray.direction)<0.0);
  if(PRECISE_TRANSPORT) {
    // Touching shells can share a plane. Offset the outgoing ray only after
    // accounting for every boundary at this point, or one interface is skipped.
    let point=surfacePosition(triangle,hit);
    let radius=1e-6*max(1.0,max(abs(point.x),max(abs(point.y),abs(point.z))));
    var stack:array<u32,64>;stack[0]=0u;var size=1u;
    var seen:array<u32,32>;seen[0]=triangle.padding0;var count=1u;
    var bounded=ray;bounded.tMax=min(ray.tMax,hitDistanceLimit(hit));
    loop {
      if(size==0u) {break;} size--;let node=nodes[stack[size]];
      if(any(point+vec3f(radius)<node.min)||any(point-vec3f(radius)>node.max)) {continue;}
      if(node.count==0u) {
        if(size+2u>64u) {next.error=4u;return next;}
        stack[size]=node.first;stack[size+1u]=node.first+1u;size+=2u;continue;
      }
      for(var i=node.first;i<node.first+node.count;i++) {
        let candidate=triangles[i];if(materials[candidate.material].kind!=2u) {continue;}
        var duplicate=false;
        for(var j=0u;j<count;j++) {if(seen[j]==candidate.padding0) {duplicate=true;break;}}
        if(duplicate) {continue;}
        let other=preciseTriangleHit(bounded,candidate,originLow);
        if(other.id==NO_HIT) {continue;}
        let delta=(other.t-hit.t)+(bitcast<f32>(other.padding)-bitcast<f32>(hit.padding));
        if(abs(delta)>1e-11*max(1.0,abs(hit.t))) {continue;}
        if(count==32u) {next.error=4u;return next;}
        seen[count]=candidate.padding0;count++;
        next=changeMedium(next,i,dot(geometricNormal(candidate),ray.direction)<0.0);
        if(next.error!=0u) {return next;}
      }
    }
  }
  return next;
}
fn cameraMedia(camera:CameraParams) -> MediumSet {
  var state:MediumSet;
  state.count=min(camera.padding1,32u);
  if(camera.padding1>32u) {state.error=4u;}
  for(var i=0u;i<state.count;i++) {
    state.entries[i]=camera.initialShells[i/4u][i%4u];state.windings[i]=1;
  }
  return state;
}
