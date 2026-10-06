// Import through the existing connected Chrome on an empty same-origin page.
// Never launches a browser or a competing renderer.
export async function createSession({ scene = 'sphere', width = 160, height = 120, depth = 16, wear = 0, rendererModule = '/src/render/intersection-renderer.ts' } = {}) {
  const { IntersectionRenderer } = await import(rendererModule);
  const { cornellScene } = await import('/src/scene/cornell.ts');
  const { loadBuiltinObj } = await import('/src/assets/builtin-obj.ts');
  const description = cornellScene('nbk7');
  if (scene !== 'sphere') {
    const model = await loadBuiltinObj(scene);
    description.meshes[6] = model.mesh;
    description.objects[6].transform = [1,0,0,0,0,1,0,0,0,0,1,0,0,1,0,1];
    description.materials[4].thin = !model.solid;
  }
  description.materials[4].surfaceWear = { scratches: wear, scuffs: wear, fingerprints: wear, seed: 1 };
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px`;
  document.body.append(canvas);
  let target = Infinity, done = false, latest, portions = [], errors = [];
  const renderer = new IntersectionRenderer(canvas, stats => {
    latest = stats;
    if (stats.status === 'ready' && stats.completionMs > 0) portions.push({ gpuMs: stats.gpuMs, completionMs: stats.completionMs, steps: stats.packetSteps, phase: stats.executedPhase });
    if (!done && stats.samples >= target) { done = true; renderer.pause(); }
  }, error => { errors.push(error.message); done = true; });
  renderer.pause(); renderer.setDisplay({ enabled: false });
  renderer.setDebugView('beauty');
  renderer.setSettings({ maxDepth: depth, maxPixels: width * height, seed: 17, photonsPerIteration: 16384, photonBatchSize: 1024 });
  const start = performance.now();
  await renderer.setScene(description);
  const preparationMs = performance.now() - start;
  const init = performance.now(); await renderer.initialize();
  const initializationMs = performance.now() - init;
  renderer.pause(); await renderer.activeFrame;
  const baseline = { pipeline: renderer.pathPipeline, workgroup: renderer.pathWorkgroup, variants: renderer.pathVariants ? new Map(renderer.pathVariants) : undefined };
  async function run({ mode = 'rgb', integrator = 'pt', samples = 4, seed = 17, tile, packetMs } = {}) {
    renderer.pause(); await renderer.activeFrame;
    if (renderer.stats.status === 'error') throw Error('Failed renderer cannot be timed');
    await renderer.prepareIntegrator(integrator, mode);
    renderer.setSettings({ mode, integrator, seed });
    renderer.invalidate();
    if (tile) renderer.tileBudget = { size: tile, observe() {} };
    if (packetMs) {
      const { PacketBudget } = await import('/src/render/compute-packets.ts');
      const budget = new PacketBudget();
      const steps = budget.steps.bind(budget);
      budget.steps = (phase, interacting) => Math.max(1, Math.min(128, Math.ceil(steps(phase, interacting) * packetMs / 8)));
      renderer.packetBudget = budget;
    }
    target = samples; done = false; errors = []; portions = [];
    const at = performance.now(); renderer.resume();
    while (!done && performance.now() - at < 240000) await new Promise(resolve => setTimeout(resolve, 10));
    const elapsedMs = performance.now() - at;
    if (!done || errors.length) throw new Error(JSON.stringify({ errors, latest }));
    const capture = await renderer.capture();
    if (!capture.sampleCounts.every(n => n === samples)) throw new Error('Nonuniform samples');
    return { elapsedMs, gpuMs: portions.reduce((sum, p) => sum + (p.gpuMs ?? 0), 0), completionMs: portions.reduce((sum,p) => sum + p.completionMs, 0), bytes: latest.bytes, errors, width: capture.width, height: capture.height, samples, emittedPhotons: capture.emittedPhotons, raw: capture.linearRgb, portions, settings: capture.settings, camera: capture.camera, computation: capture.computation };
  }
  async function install({ workgroup = [8,8], transform = source => source, threaded = true, source } = {}) {
    renderer.pause();
    const { pathShader } = await import('/src/transport/shaders.ts');
    const { fastTransportShader } = await import('/src/transport/fast-source.ts');
    const { checkedShader } = await import('/src/gpu/device.ts');
    const device = renderer.device;
    const start = performance.now();
    const module = await checkedShader(device, transform(fastTransportShader(source ?? pathShader, threaded)), 'Performance candidate');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main', constants: { PT_WORKGROUP_X: workgroup[0], PT_WORKGROUP_Y: workgroup[1] } } });
    renderer.pathPipeline = pipeline; renderer.pathWorkgroup = workgroup; renderer.updateGroups();
    renderer.pathVariants?.set(renderer.specializedPtSource ? 'rgb' : 'generic', {pipeline, repair: renderer.pathRepairPipeline});
    return performance.now() - start;
  }
  return { renderer, description, preparationMs, initializationMs, startupTimings: renderer.startupTimings, run, install,
    kernelState() { return {pipeline: renderer.pathPipeline, repair: renderer.pathRepairPipeline, workgroup: renderer.pathWorkgroup, variants: renderer.pathVariants ? new Map(renderer.pathVariants) : undefined}; },
    useKernel(state) { renderer.pathPipeline=state.pipeline;renderer.pathRepairPipeline=state.repair;renderer.pathWorkgroup=state.workgroup;if(state.variants)renderer.pathVariants=new Map(state.variants);renderer.updateGroups(); },
    restore() { renderer.pathPipeline = baseline.pipeline; renderer.pathWorkgroup = baseline.workgroup; if (baseline.variants) renderer.pathVariants = new Map(baseline.variants); renderer.updateGroups(); },
    async dispose() { const device = renderer.device; renderer.dispose(); canvas.remove(); if (device) await device.lost; } };
}

export function difference(a, b) {
  if (a.length !== b.length) throw new Error('Different dimensions');
  let squared = 0, energy = 0, max = 0, different = 0, sumA = 0, sumB = 0;
  for (let i = 0; i < a.length; i++) { const delta = a[i] - b[i]; squared += delta * delta; energy += a[i] * a[i]; max = Math.max(max, Math.abs(delta)); different += delta !== 0; sumA += a[i]; sumB += b[i]; }
  return { nrmse: Math.sqrt(squared / Math.max(energy, 1e-30)), max, different, relativeEnergy: Math.abs(sumA - sumB) / Math.max(Math.abs(sumA), 1e-30) };
}
