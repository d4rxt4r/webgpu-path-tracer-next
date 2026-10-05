import { mat4 } from "gl-matrix";
import { makeStructuredView } from "webgpu-utils";
import { definitions } from "../accel/pack";
import { createDevice, checkedShader } from "../gpu/device";
import { pathCore } from "../transport/shaders";

/** Independent surface grid exercises zero, individual effects, seeds, sides,
 * transformed points and matched BSDF evaluation in both transport modes. */
export async function verifySurfaceWear() {
  const { device, name } = await createDevice();
  const size = 128, count = size * size, cases = 10;
  const def = definitions.structs.Material!;
  const data = new ArrayBuffer(def.size * cases);
  const motion = mat4.create();
  mat4.translate(motion, motion, [0.13, 0.8, -0.12]);
  mat4.rotateY(motion, motion, 0.7);
  mat4.rotateX(motion, motion, -0.4);
  mat4.scale(motion, motion, [1.7, 1.7, 1.7]);
  const inverse = mat4.invert(mat4.create(), motion)!;
  const controls = [[0, 0, 0, 1], [0, 0, 0, 37], [1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1],
    [0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 2], [1, 1, 1, 65535], [0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1]];
  controls.forEach((wearParams, index) => makeStructuredView(def, data, def.size * index).set({
    kind: index === 8 ? 5 : 2, color: [1, 1, 1], ior: 1.5, textureParams: [0.03, 0, 0, 0],
    worldToTexture: index === 9 ? inverse : mat4.create(), wearParams, wearBounds: [0.5, 0.5, 0.1, 0],
  }));
  const materialBuffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(materialBuffer, 0, data);
  const output = device.createBuffer({ size: count * cases * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const spectra = device.createBuffer({ size: 471 * 4, usage: GPUBufferUsage.STORAGE });
  const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const timingBuffers: GPUBuffer[] = [];
  let queries: GPUQuerySet | undefined;
  device.pushErrorScope("validation");
  try {
    const module = await checkedShader(device, pathCore + `
      @group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
      const motion=mat4x4f(${Array.from(motion).map(v => `${v}`).join(",")});
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
        let i=id.x;let test=id.y;let uv=(vec2f(f32(i%128u),f32(i/128u))+0.5)/128.0-0.5;
        let original=materials[test];let local=vec3f(uv,0.1);let n=vec3f(0,0,1);
        var position=local;var ng=n;
        if(test==9u) {position=(motion*vec4f(local,1)).xyz;ng=normalize(motion[2].xyz);}
        let surface=dielectricWear(original,position,ng,ng);var material=original;material.textureParams.x=surface.roughness;
        let back=dielectricWear(original,select(vec3f(uv,-0.1),position,test==9u),select(-n,ng,test==9u),select(-n,ng,test==9u));
        let inward=dielectricWear(original,position,-ng,-ng);
        let wo=ng;let random=wearRandom(i+17u);
        let event=sampleEditedDielectric(material,-wo,ng,surface.normal,1.5,0.0,vec2f(fract(f32(i)*0.6180339),fract(f32(i)*0.4142135)),random,true);
        var mismatch=0.0;
        if(event.pdf>0.0) {
          let evaluated=roughDielectricEval(material,wo,event.direction,ng,surface.normal,1.5,0.0,true);
          mismatch=abs(evaluated.pdf-event.pdf)/max(event.pdf,1e-8);
        }
        let offset=(test*16384u+i)*3u;
        output[offset]=vec4f(surface.normal,surface.roughness);
        output[offset+1u]=vec4f(event.weight.x,event.pdf,mismatch,back.roughness);
        output[offset+2u]=vec4f(dot(surface.normal,ng),length(surface.normal),inward.roughness,0);
      }`, "surface wear grid / sampling");
    const started = performance.now();
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const compileMs = performance.now() - started;
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: output } }, { binding: 5, resource: { buffer: materialBuffer } },
      { binding: 9, resource: { buffer: spectra } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count / 64, cases); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ); const values = new Float32Array(readback.getMappedRange()).slice(); readback.unmap();
    const validation = await device.popErrorScope();
    if (validation) throw new Error(validation.message);
    const results = controls.map((wear, test) => {
      let invalid = 0, mismatch = 0, changed = 0, sideDifference = 0, inwardDifference = 0, min = 1, max = 0, energy = 0;
      for (let i = 0; i < count; i++) {
        const o = (test * count + i) * 12, roughness = values[o + 3]!;
        if (!values.subarray(o, o + 12).every(Number.isFinite) || roughness < 0 || roughness > 1
            || values[o + 8]! <= 0 || Math.abs(values[o + 9]! - 1) > 1e-5 || values[o + 4]! < 0) invalid++;
        mismatch = Math.max(mismatch, values[o + 6]!);
        min = Math.min(min, roughness); max = Math.max(max, roughness);
        if (roughness > 0.031) changed++;
        sideDifference += Math.abs(roughness - values[o + 7]!) / count;
        inwardDifference = Math.max(inwardDifference, Math.abs(roughness - values[o + 10]!));
        energy += values[o + 4]! / count;
      }
      return { wear, thin: test === 8, invalid, mismatch, min, max, changed, sideDifference, inwardDifference, energy };
    });
    let transformRoughness = 0, transformNormal = 0, cleanDifference = 0, seedDifference = 0;
    for (let i = 0; i < count; i++) {
      const base = (5 * count + i) * 12, moved = (9 * count + i) * 12;
      transformRoughness = Math.max(transformRoughness, Math.abs(values[base + 3]! - values[moved + 3]!));
      for (let axis = 0; axis < 3; axis++) {
        const expected = (motion[axis]! * values[base]! + motion[4 + axis]! * values[base + 1]! + motion[8 + axis]! * values[base + 2]!) / 1.7;
        transformNormal = Math.max(transformNormal, Math.abs(expected - values[moved + axis]!));
      }
      for (let c = 0; c < 4; c++) cleanDifference = Math.max(cleanDifference, Math.abs(values[i * 12 + c]! - values[(count + i) * 12 + c]!));
      seedDifference += Math.abs(values[base + 3]! - values[(6 * count + i) * 12 + 3]!) / count;
    }
    let gpuMs: { clean: number; worn: number } | undefined;
    if (device.features.has("timestamp-query")) {
      queries = device.createQuerySet({ type: "timestamp", count: 4 });
      const resolve = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const times = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      timingBuffers.push(resolve, times);
      for (let test = 0; test < 2; test++) {
        const offset = test === 0 ? 0 : def.size * 5;
        device.queue.writeBuffer(materialBuffer, 0, data.slice(offset, offset + def.size));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass({ timestampWrites: { querySet: queries, beginningOfPassWriteIndex: test * 2, endOfPassWriteIndex: test * 2 + 1 } });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group);
        for (let repeat = 0; repeat < 4; repeat++) pass.dispatchWorkgroups(count / 64, 1);
        pass.end(); device.queue.submit([encoder.finish()]);
      }
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(queries, 0, 4, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, times, 0, 32); device.queue.submit([encoder.finish()]);
      await times.mapAsync(GPUMapMode.READ);
      const stamps = new BigUint64Array(times.getMappedRange());
      gpuMs = { clean: Number(stamps[1]! - stamps[0]!) / 4e6, worn: Number(stamps[3]! - stamps[2]!) / 4e6 };
      times.unmap();
    }
    return { name, compileMs, gpuMs, results, cleanDifference, seedDifference, transformRoughness, transformNormal };
  } finally { queries?.destroy(); timingBuffers.forEach(buffer => buffer.destroy()); materialBuffer.destroy(); output.destroy(); spectra.destroy(); readback.destroy(); device.destroy(); }
}
