// Independent signed windings; identity and insertion order determine the medium.
// Only the SPPM common kernel specializes this capacity. Repair retains 32.
const MEDIUM_CAPACITY: u32 = 32u;
struct MediumSet { entries: array<u32,MEDIUM_CAPACITY>, windings: array<i32,MEDIUM_CAPACITY>, count: u32, error: u32 }
struct MediumChange { triangle: u32, slot: u32, before: i32, after: i32, medium: u32, error: u32 }
struct MediumUndo { triangle: u32, slot: u32, before: i32, after: i32 }
// The journal is eliminated from common kernels. Precise touching boundaries
// form one transaction; reflection reverses it to restore the insertion order.
struct MediumJournal { changes: array<MediumUndo,32>, count: u32, error: u32 }
fn activeMedium(state: ptr<function,MediumSet>) -> u32 {
  if((*state).count==0u) {return NO_HIT;}
  return (*state).entries[(*state).count-1u];
}
fn previewMediumChange(state: ptr<function,MediumSet>, triangleIndex: u32, entering: bool) -> MediumChange {
  var change=MediumChange(triangleIndex,(*state).count,0,select(-1,1,entering),activeMedium(state),0u);
  let boundary=triangles[triangleIndex].padding0;
  for(var i=0u;i<(*state).count;i++) {
    if(triangles[(*state).entries[i]].padding0==boundary) {
      change.slot=i;change.triangle=(*state).entries[i];
      change.before=(*state).windings[i];change.after+=change.before;break;
    }
  }
  if(change.before==0) {
    if((*state).count==MEDIUM_CAPACITY) {change.error=select(4u,5u,MEDIUM_CAPACITY<32u);return change;}
    change.medium=triangleIndex;
  } else if(change.after==0 && change.slot+1u==(*state).count) {
    change.medium=NO_HIT;
    if(change.slot>0u) {change.medium=(*state).entries[change.slot-1u];}
  }
  return change;
}
fn applyMediumChange(state: ptr<function,MediumSet>, change: MediumChange) {
  if(change.before==0) {
    (*state).entries[change.slot]=change.triangle;(*state).windings[change.slot]=change.after;(*state).count++;
  } else if(change.after!=0) {(*state).windings[change.slot]=change.after;}
  else {
    for(var i=change.slot;i+1u<(*state).count;i++) {
      (*state).entries[i]=(*state).entries[i+1u];(*state).windings[i]=(*state).windings[i+1u];
    }
    (*state).count--;
  }
}
fn undoMediumChange(state: ptr<function,MediumSet>, change: MediumUndo) {
  if(change.before==0) {(*state).count--;return;}
  if(change.after==0) {
    for(var i=(*state).count;i>change.slot;i--) {
      (*state).entries[i]=(*state).entries[i-1u];(*state).windings[i]=(*state).windings[i-1u];
    }
    (*state).count++;
    (*state).entries[change.slot]=change.triangle;
  }
  (*state).windings[change.slot]=change.before;
}
fn mediumIor(index: u32, wavelength:f32) -> f32 {
  if(index==NO_HIT) {return 1.0;}
  return materialIor(materials[triangles[index].material],wavelength);
}
fn journalMediumChange(state:ptr<function,MediumSet>,journal:ptr<function,MediumJournal>,triangle:u32,entering:bool) {
  if((*journal).count==32u) {(*journal).error=4u;return;}
  let change=previewMediumChange(state,triangle,entering);
  if(change.error!=0u) {(*journal).error=change.error;return;}
  (*journal).changes[(*journal).count]=MediumUndo(change.triangle,change.slot,change.before,change.after);(*journal).count++;
  applyMediumChange(state,change);
}
fn beginMediumAtSurface(state:ptr<function,MediumSet>,ray:Ray,originLow:vec3f,hit:Hit,journal:ptr<function,MediumJournal>) {
  if(PRECISE_TRANSPORT) {
    // Every live record is overwritten before use. Reuse the payload across
    // boundaries instead of zero-initializing the array at each interaction.
    (*journal).count=0u;(*journal).error=0u;
    let triangle=triangles[hit.triangle];
    journalMediumChange(state,journal,hit.triangle,dot(geometricNormal(triangle),ray.direction)<0.0);
    if((*journal).error!=0u) {return;}
    // Account for every coincident boundary before offsetting the outgoing ray.
    let point=surfacePosition(triangle,hit);
    let radius=1e-6*max(1.0,max(abs(point.x),max(abs(point.y),abs(point.z))));
    var stack:array<u32,64>;stack[0]=0u;var size=1u;
    var bounded=ray;bounded.tMax=min(ray.tMax,hitDistanceLimit(hit));
    loop {
      if(size==0u) {break;} size--;let node=nodes[stack[size]];
      if(any(point+vec3f(radius)<node.min)||any(point-vec3f(radius)>node.max)) {continue;}
      if(node.count==0u) {
        if(size+2u>64u) {(*journal).error=4u;return;}
        stack[size]=node.first;stack[size+1u]=node.first+1u;size+=2u;continue;
      }
      for(var i=node.first;i<node.first+node.count;i++) {
        let candidate=triangles[i];if(materials[candidate.material].kind!=2u) {continue;}
        var duplicate=false;
        for(var j=0u;j<(*journal).count;j++) {
          if(triangles[(*journal).changes[j].triangle].padding0==candidate.padding0) {duplicate=true;break;}
        }
        if(duplicate) {continue;}
        let other=preciseTriangleHit(bounded,candidate,originLow);
        if(other.id==NO_HIT) {continue;}
        let delta=(other.t-hit.t)+(bitcast<f32>(other.padding)-bitcast<f32>(hit.padding));
        if(abs(delta)>1e-11*max(1.0,abs(hit.t))) {continue;}
        journalMediumChange(state,journal,i,dot(geometricNormal(candidate),ray.direction)<0.0);
        if((*journal).error!=0u) {return;}
      }
    }
  }
}
fn finishMediumAtSurface(state:ptr<function,MediumSet>,change:MediumChange,journal:ptr<function,MediumJournal>,transmitted:bool) {
  if(PRECISE_TRANSPORT) {
    if(!transmitted) {
      for(var i=(*journal).count;i>0u;i--) {undoMediumChange(state,(*journal).changes[i-1u]);}
    }
    return;
  }
  if(transmitted) {applyMediumChange(state,change);}
}
fn cameraMedia(camera:CameraParams) -> MediumSet {
  var state:MediumSet;
  if(camera.padding1>MEDIUM_CAPACITY) {state.error=select(4u,5u,MEDIUM_CAPACITY<32u);return state;}
  state.count=camera.padding1;
  for(var i=0u;i<state.count;i++) {
    state.entries[i]=camera.initialShells[i/4u][i%4u];state.windings[i]=1;
  }
  return state;
}
