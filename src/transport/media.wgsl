// Independent shells, removed by identity rather than by stack order.
// Entries are representative triangle indices in the packed BVH.
struct MediumSet { entries: array<u32,32>, count: u32, error: u32 }
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
  if(entering) {
    if(found!=32u || state.count==32u) {next.error=4u;return next;}
    next.entries[next.count]=triangleIndex;next.count++;
  } else {
    if(found==32u) {next.error=4u;return next;}
    for(var i=found;i+1u<next.count;i++) {next.entries[i]=next.entries[i+1u];}
    next.count--;
  }
  return next;
}
fn mediumIor(state: MediumSet, wavelength:f32) -> f32 {
  let index=activeMedium(state);
  if(index==NO_HIT) {return 1.0;}
  return materialIor(materials[triangles[index].material],wavelength);
}
fn cameraMedia(camera:CameraParams) -> MediumSet {
  var state:MediumSet;
  state.count=min(camera.padding1,32u);
  if(camera.padding1>32u) {state.error=4u;}
  for(var i=0u;i<state.count;i++) {state.entries[i]=camera.initialShells[i/4u][i%4u];}
  return state;
}
