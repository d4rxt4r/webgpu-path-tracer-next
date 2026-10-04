// A one-word legacy buffer still collects the total. Live rendering allocates
// a diagnostic prefix plus a bounded replay queue. The first failing invocation
// is recorded without a spin lock.
@group(0) @binding(4) var<storage,read_write> transportErrors: array<atomic<u32>>;
fn reportTransportError(kind:u32,phase:u32,index:u32,depth:u32,triangle:u32,medium:u32) {
  atomicAdd(&transportErrors[0],1u);
  if(arrayLength(&transportErrors)<12u) {return;}
  if(atomicExchange(&transportErrors[1],1u)!=0u) {return;}
  atomicStore(&transportErrors[2],kind);atomicStore(&transportErrors[3],phase);
  atomicStore(&transportErrors[4],params.frame);atomicStore(&transportErrors[5],index);
  atomicStore(&transportErrors[6],depth);atomicStore(&transportErrors[7],triangle);
  atomicStore(&transportErrors[8],medium);atomicStore(&transportErrors[9],params.seed);
  atomicStore(&transportErrors[10],params.size.x);atomicStore(&transportErrors[11],params.size.y);
}

// Recompute uncertain paths with the same samples before committing their output.
// Header words 12..16 hold count, indirect dispatch XYZ and dense fallback.
// The bounded queue shares binding 4; no ninth storage binding is required.
fn enqueueTransportRetry(index:u32,total:u32) {
  let count=atomicAdd(&transportErrors[12],1u);
  atomicStore(&transportErrors[14],1u);atomicStore(&transportErrors[15],1u);
  if(count<arrayLength(&transportErrors)-32u) {
    atomicStore(&transportErrors[32u+count],index);
    atomicMax(&transportErrors[13],(count+64u)/64u);
  } else {
    atomicStore(&transportErrors[16],1u);
    atomicMax(&transportErrors[13],(total+63u)/64u);
  }
}
fn transportRetryIndex(invocation:u32,total:u32)->u32 {
  if(atomicLoad(&transportErrors[16])!=0u) {return select(NO_HIT,invocation,invocation<total);}
  if(invocation>=atomicLoad(&transportErrors[12])) {return NO_HIT;}
  return atomicLoad(&transportErrors[32u+invocation]);
}
