import { hash32 } from '../src/transport/sampler.ts';

/** Integer precomputation only: no changes to floating point wear or samples. */
export function constantWear(source) {
  return source.replace('wearHash(i+137u)', `array<u32,3>(${[137,138,139].map(n=>hash32(n)+'u').join(',')})[i]`)
    .replace('wearHash(axis+731u)', `array<u32,3>(${[731,732,733].map(n=>hash32(n)+'u').join(',')})[axis]`);
}
export function constantOwen(source) {
  return source.replace('hash32(level)', `array<u32,24>(${Array.from({length:24},(_,n)=>hash32(n)+'u').join(',')})[level]`);
}

/** Pack the same geometry with a different SAH leaf size. Both retry paths
 * use the replacement layout, including its regenerated escape links. */
export async function leafCandidate(session, leafSize) {
  const [{bakeTriangles},{buildBvh},{packBvh},{packTransport},{GpuScene}] = await Promise.all([
    import('/src/accel/geometry.ts'),import('/src/accel/bvh.ts'),import('/src/accel/pack.ts'),import('/src/accel/materials.ts'),import('/src/gpu/scene.ts')]);
  const renderer=session.renderer;
  renderer.pause();await renderer.activeFrame;
  const at=performance.now(), bvh=buildBvh(bakeTriangles(session.description),48,leafSize);
  const packed={...packBvh(bvh),...packTransport(session.description,bvh)};
  const preparationMs=performance.now()-at;
  const baseline={scene:renderer.scene,packed:renderer.packed};
  // Light IDs are source primitive IDs, independent of BVH order. Keep the
  // original emitter CDF/order so the same Sobol sample selects the same light.
  packed.lights=baseline.packed.lights;
  const scene=new GpuScene(renderer.device,packed,renderer.environment);
  const install=state=>{renderer.scene=state.scene;renderer.packed=state.packed;renderer.stats.nodes=state.packed.nodeCount;renderer.updateGroups();};
  return {preparationMs,nodeCount:packed.nodeCount,bytes:scene.bytes,
    apply(){install({scene,packed});},restore(){install(baseline);},dispose(){scene.dispose();}};
}
