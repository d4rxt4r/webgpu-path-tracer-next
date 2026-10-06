import { sppmShader } from "../src/transport/sppm-shader.ts";
import { checkedShader } from "../src/gpu/device.ts";

/** Count/scan/scatter prototype, installed only by the benchmark harness. */
export async function installCsrCandidate(renderer) {
  const device = renderer.device,
    base = renderer.sppm;
  const reference = sppmShader.replaceAll("\r\n", "\n");
  const gatherStart = reference.indexOf(
    "@compute @workgroup_size(8,8) fn gatherMain",
  );
  const gatherEnd = reference.indexOf(
    "@compute @workgroup_size(8,8) fn updateMain",
    gatherStart,
  );
  let gather = reference.slice(gatherStart, gatherEnd);
  gather = gather
    .replace(
      "var link=atomicLoad(&heads[cellHash(targetCell)]);var visited=0u;",
      `let bucket=cellHash(targetCell);let blocks=(sppm.hashMask+256u)/256u;
    let first=csrData[bucket]+csrData[sppm.hashMask+1u+blocks+bucket/256u];let countInBucket=atomicLoad(&heads[bucket]);`,
    )
    .replace(
      "while(link!=0u) {\n      let index=link-1u;",
      `for(var item=0u;item<countInBucket;item++) {

      let index=csrData[sppm.hashMask+1u+2u*blocks+first+item];`,
    )
    .replace("||visited>=arrayLength(&photons)", "")
    .replace("link=photon.next;visited++;", "");
  if (gather.includes("while(link") || gather.includes("visited"))
    throw Error("CSR gather marker mismatch");
  const code =
    reference
      .replace("fn hashMain(", "fn legacyHashMain(")
      .replace("fn gatherMain(", "fn legacyGatherMain(") +
    `
@group(0) @binding(23) var<storage,read_write> csrData:array<u32>;
@compute @workgroup_size(64) fn hashMain(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=sppm.batchCount*(params.maxDepth+1u)){return;}
  // Keep the original bind layout; actual hashing is encoded as separate passes.
  if(params.size.x==0u&&atomicLoad(&heads[0])==0u){photons[id.x].valid=sppm.batchCount;}
}
@compute @workgroup_size(64) fn csrCountMain(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=sppm.batchCount*(params.maxDepth+1u)||photons[id.x].valid==0u){return;}
  let cell=vec3i(floor(photons[id.x].position/sppm.initialRadius));photons[id.x].cell=cell;
  atomicAdd(&heads[cellHash(cell)],1u);
}
var<workgroup> scanValues:array<u32,256>;
@compute @workgroup_size(256) fn csrScanMain(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3u) {
  var value=0u;if(id.x<arrayLength(&heads)){value=atomicLoad(&heads[id.x]);}
  scanValues[lane]=value;workgroupBarrier();
  for(var stride=1u;stride<256u;stride*=2u){
    var add=0u;if(lane>=stride){add=scanValues[lane-stride];}
    workgroupBarrier();scanValues[lane]+=add;workgroupBarrier();
  }
  if(id.x<arrayLength(&heads)){csrData[id.x]=scanValues[lane]-value;}
  if(lane==255u){csrData[arrayLength(&heads)+group.x]=scanValues[lane];}
}
@compute @workgroup_size(64) fn csrBlockMain(@builtin(global_invocation_id) id:vec3u) {
  let blocks=(sppm.hashMask+256u)/256u;if(id.x>=blocks){return;}
  var sum=0u;for(var i=0u;i<id.x;i++){sum+=csrData[sppm.hashMask+1u+i];}csrData[sppm.hashMask+1u+blocks+id.x]=sum;
}
@compute @workgroup_size(64) fn csrScatterMain(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=sppm.batchCount*(params.maxDepth+1u)||photons[id.x].valid==0u){return;}
  let bucket=cellHash(photons[id.x].cell);let blocks=(sppm.hashMask+256u)/256u;
  let first=csrData[bucket]+csrData[sppm.hashMask+1u+blocks+bucket/256u];let item=atomicAdd(&heads[bucket],1u);
  csrData[sppm.hashMask+1u+2u*blocks+first+item]=id.x;
}
` +
    gather;
  const module = await checkedShader(device, code, "SPPM CSR experiment");
  const entries = [
    "hash",
    "csrCount",
    "csrScan",
    "csrBlock",
    "csrScatter",
    "gather",
  ];
  const pipelines = Object.fromEntries(
    await Promise.all(
      entries.map(async (name) => [
        name,
        await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module, entryPoint: name + "Main" },
        }),
      ]),
    ),
  );
  const blocks = Math.ceil(base.heads.size / 4 / 256);
  const create = (size) =>
    device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  const data = create(base.heads.size + blocks * 8 + (base.photons.size / 80) * 4);
  const buffers = [data];
  const resources = {
    1: base.camera,
    4: renderer.diagnostic,
    10: base.points,
    11: base.uniform,
    21: base.photons,
    22: base.heads,
    5: renderer.scene.materials,
    7: renderer.sobol,
    9: renderer.scene.spectra,
    23: data,
  };
  const bindings = {
    hash: [1, 11, 21, 22],
    csrCount: [1, 11, 21, 22],
    csrScan: [22, 23],
    csrBlock: [11, 23],
    csrScatter: [1, 11, 21, 22, 23],
    gather: [1, 4, 5, 7, 9, 10, 11, 21, 22, 23],
  };
  const groups = Object.fromEntries(
    entries.map((name) => [
      name,
      device.createBindGroup({
        layout: pipelines[name].getBindGroupLayout(0),
        entries: bindings[name].map((binding) => ({
          binding,
          resource: { buffer: resources[binding] },
        })),
      }),
    ]),
  );
  const originals = { hash: base.pipelines.hash, gather: base.pipelines.gather };
  const originalGroups = { hash: base.groups.hash, gather: base.groups.gather };
  const apply = () => {
  base.pipelines.hash = pipelines.hash;
  base.groups.hash = groups.hash;
  base.pipelines.gather = pipelines.gather;
  base.groups.gather = groups.gather;
  };
  const configure = base.configure.bind(base);
  base.configure = (...args) => { Object.assign(base.pipelines, originals); configure(...args); apply(); };
  apply();
  const encode = base.encodeStep.bind(base);
  base.encodeStep = (encoder, snapshots) => {
    const phase = base.phase;
    const result = encode(encoder, snapshots);
    if (phase === "photon") {
      const jobs = Math.ceil(
        (base.settings.photonBatchSize * (base.settings.maxDepth + 1)) / 64,
      );
      for (const [name, count] of [
        ["csrCount", jobs],
        ["csrScan", blocks],
        ["csrBlock", Math.ceil(blocks / 64)],
        ["csrScatter", jobs],
      ]) {
        if (name === "csrScatter") encoder.clearBuffer(base.heads);
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines[name]);
        pass.setBindGroup(0, groups[name]);
        pass.dispatchWorkgroups(count);
        pass.end();
      }
    }
    return result;
  };
  const getBytes = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(base),
    "bytes",
  ).get;
  Object.defineProperty(base, "bytes", {
    get: () =>
      getBytes.call(base) + buffers.reduce((sum, b) => sum + b.size, 0),
  });
  const dispose = base.dispose.bind(base);
  base.dispose = () => {
    dispose();
    buffers.forEach((b) => b.destroy());
  };
  const candidateEncode = base.encodeStep, candidateConfigure = base.configure;
  return {bytes: data.size, apply() { base.encodeStep = candidateEncode; base.configure = candidateConfigure; apply(); }, restore() { base.encodeStep = encode; base.configure = configure; Object.assign(base.pipelines, originals); Object.assign(base.groups, originalGroups); renderer.updateGroups(); }};
}
