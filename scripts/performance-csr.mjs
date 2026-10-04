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
      `let bucket=cellHash(targetCell);let blocks=arrayLength(&csrBlocks)/2u;
    let first=csrOffsets[bucket]+csrBlocks[blocks+bucket/256u];let countInBucket=atomicLoad(&heads[bucket]);`,
    )
    .replace(
      "while(link!=0u) {\n      let index=link-1u;",
      `for(var item=0u;item<countInBucket;item++) {
      if(first+item>=arrayLength(&csrIndices)){atomicAdd(&errors,1u);return;}
      let index=csrIndices[first+item];`,
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
@group(0) @binding(23) var<storage,read_write> csrOffsets:array<u32>;
@group(0) @binding(24) var<storage,read_write> csrBlocks:array<u32>;
@group(0) @binding(25) var<storage,read_write> csrIndices:array<u32>;
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
  if(id.x<arrayLength(&heads)){csrOffsets[id.x]=scanValues[lane]-value;}
  if(lane==255u){csrBlocks[group.x]=scanValues[lane];}
}
@compute @workgroup_size(64) fn csrBlockMain(@builtin(global_invocation_id) id:vec3u) {
  let blocks=arrayLength(&csrBlocks)/2u;if(id.x>=blocks){return;}
  var sum=0u;for(var i=0u;i<id.x;i++){sum+=csrBlocks[i];}csrBlocks[blocks+id.x]=sum;
}
@compute @workgroup_size(64) fn csrScatterMain(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=sppm.batchCount*(params.maxDepth+1u)||photons[id.x].valid==0u){return;}
  let bucket=cellHash(photons[id.x].cell);let blocks=arrayLength(&csrBlocks)/2u;
  let first=csrOffsets[bucket]+csrBlocks[blocks+bucket/256u];let item=atomicAdd(&heads[bucket],1u);
  csrIndices[first+item]=id.x;
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
  const offsets = create(base.heads.size),
    scratch = create(blocks * 8),
    indices = create((base.photons.size / 64) * 4);
  const buffers = [offsets, scratch, indices];
  const resources = {
    1: base.camera,
    4: renderer.diagnostic,
    10: base.points,
    11: base.uniform,
    21: base.photons,
    22: base.heads,
    23: offsets,
    24: scratch,
    25: indices,
  };
  const bindings = {
    hash: [1, 11, 21, 22],
    csrCount: [1, 11, 21, 22],
    csrScan: [22, 23, 24],
    csrBlock: [24],
    csrScatter: [1, 11, 21, 22, 23, 24, 25],
    gather: [1, 4, 10, 11, 21, 22, 23, 24, 25],
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
  base.pipelines.hash = pipelines.hash;
  base.groups.hash = groups.hash;
  base.pipelines.gather = pipelines.gather;
  base.groups.gather = groups.gather;
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
}
