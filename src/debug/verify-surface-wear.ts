import { defaultWearEffect, packWearEffect, wearEffects } from "../scene/surface-wear";
import { specializeSurfaceWear } from "../transport/wear-source";
import { mat4 } from "gl-matrix";
import { makeStructuredView } from "webgpu-utils";
import { definitions } from "../accel/pack";
import { createDevice, checkedShader } from "../gpu/device";
import { pathCore } from "../transport/shaders";

/** Independent surface grid exercises zero, individual effects, seeds, sides,
 * transformed points and matched BSDF evaluation in both transport modes. */
export async function verifySurfaceWear() {
  const { device, name } = await createDevice();
  const size = 128, count = size * size, cases = 21;
  const def = definitions.structs.Material!;
  const data = new ArrayBuffer(def.size * cases);
  const motion = mat4.create();
  mat4.translate(motion, motion, [0.13, 0.8, -0.12]);
  mat4.rotateY(motion, motion, 0.7);
  mat4.rotateX(motion, motion, -0.4);
  mat4.scale(motion, motion, [1.7, 1.7, 1.7]);
  const inverse = mat4.invert(mat4.create(), motion)!;
  const controls = [[0, 0, 0, 1], [0, 0, 0, 37], [1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1],
    [0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 2], [1, 1, 1, 65535], [0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1],
    [1,0,0,37],[0,1,0,37],[0,0,1,37], [1,0,0,1],[0,1,0,1],[0,0,1,1],
    [1,0,0,1],[0,1,0,1],[0,0,1,1], [0,1,0,1],[0,1,0,1]];
  controls.forEach((wearParams, index) => makeStructuredView(def, data, def.size * index).set({
    kind: index === 8 ? 5 : 2, color: [1, 1, 1], ior: 1.5, textureParams: [0.03, 0, 0, 0],
    worldToTexture: index === 9 || index === 20 ? inverse : mat4.create(), wearParams, wearBounds: [0.5, 0.5, 0.1, 2],
    wearEffects: wearEffects.map((name, effect) => packWearEffect(name, {...defaultWearEffect(name),
      seed: index >= 13 && index <= 15 && effect !== index - 13 ? 137 : wearParams[3]!,
      scale: index >= 16 && index <= 18 ? 2 : 1, space: index >= 19 ? "scene" : "model"})),
    wearPhysical: index === 20 ? mat4.fromScaling(mat4.create(), [1.7,1.7,1.7]) : mat4.create(),
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
    const source = pathCore + `
      @group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
      const motion=mat4x4f(${Array.from(motion).map(v => `${v}`).join(",")});
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
        let i=id.x;let test=id.y;let uv=(vec2f(f32(i%128u),f32(i/128u))+0.5)/128.0-0.5;
        let original=materials[test];var local=vec3f(uv,0.1);if(test==20u){local/=1.7;}let n=vec3f(0,0,1);
        var position=local;var ng=n;
        if(test==9u || test==20u) {position=(motion*vec4f(local,1)).xyz;ng=normalize(motion[2].xyz);}
        let surface=dielectricWear(original,position,ng,ng);var material=original;material.textureParams.x=surface.roughness;
        let back=dielectricWear(original,select(vec3f(uv,-0.1),position,(test==9u || test==20u)),select(-n,ng,(test==9u || test==20u)),select(-n,ng,(test==9u || test==20u)));
        let inward=dielectricWear(original,position,-ng,-ng);
        let wo=ng;let random=fract(f32(i+17u)*0.317837);
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
      }`;
    const module = await checkedShader(device, source, "surface wear grid / sampling");
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
    const seedChanges: number[] = [], unrelatedSeedDifferences: number[] = [], scaleChanges: number[] = [];
    for (let effect=0; effect<3; effect++) {
      let seed=0, unrelated=0, scale=0;
      for(let i=0;i<count;i++) for(let channel=0;channel<4;channel++) {
        const base=((2+effect)*count+i)*12+channel;
        seed += Math.abs(values[base]! - values[((10+effect)*count+i)*12+channel]!)/count;
        unrelated = Math.max(unrelated, Math.abs(values[base]! - values[((13+effect)*count+i)*12+channel]!));
        scale += Math.abs(values[base]! - values[((16+effect)*count+i)*12+channel]!)/count;
      }
      seedChanges.push(seed); unrelatedSeedDifferences.push(unrelated); scaleChanges.push(scale);
    }
    let physicalRoughness = 0, physicalNormal = 0;
    for(let i=0;i<count;i++) {
      const base=(19*count+i)*12, moved=(20*count+i)*12;
      physicalRoughness=Math.max(physicalRoughness,Math.abs(values[base+3]!-values[moved+3]!));
      for(let axis=0;axis<3;axis++) {
        const expected=(motion[axis]!*values[base]!+motion[4+axis]!*values[base+1]!+motion[8+axis]!*values[base+2]!)/1.7;
        physicalNormal=Math.max(physicalNormal,Math.abs(expected-values[moved+axis]!));
      }
    }
    let cleanPipeline: GPUComputePipeline | undefined;
    const variantDifferences: number[] = [];
    for (const [mask, row] of [[0,0],[1,2],[2,3],[4,4]]) {
      const module = await checkedShader(device, specializeSurfaceWear(source, mask!), `wear mask ${mask}`);
      const variant = await device.createComputePipelineAsync({layout:"auto", compute:{module,entryPoint:"main"}});
      if (mask === 0) cleanPipeline = variant;
      const variantGroup = device.createBindGroup({layout:variant.getBindGroupLayout(0), entries:[
        {binding:0,resource:{buffer:output}}, {binding:5,resource:{buffer:materialBuffer}}, {binding:9,resource:{buffer:spectra}},
      ]});
      const encoder=device.createCommandEncoder(), pass=encoder.beginComputePass();
      pass.setPipeline(variant);pass.setBindGroup(0,variantGroup);pass.dispatchWorkgroups(count/64,cases);pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,output.size);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const actual=new Float32Array(readback.getMappedRange());
      let difference=0;
      for(let i=0;i<count;i++) for(let channel=0;channel<12;channel++) {
        const offset=(row!*count+i)*12+channel;
        difference=Math.max(difference,Math.abs(actual[offset]!-values[offset]!));
      }
      readback.unmap();variantDifferences.push(difference);
    }
    let gpuMs: { clean: number; worn: number; specializedClean: number } | undefined;
    if (device.features.has("timestamp-query")) {
      queries = device.createQuerySet({ type: "timestamp", count: 6 });
      const resolve = device.createBuffer({ size: 48, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const times = device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      timingBuffers.push(resolve, times);
      for (let test = 0; test < 3; test++) {
        const offset = test === 1 ? def.size * 5 : 0;
        device.queue.writeBuffer(materialBuffer, 0, data.slice(offset, offset + def.size));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass({ timestampWrites: { querySet: queries, beginningOfPassWriteIndex: test * 2, endOfPassWriteIndex: test * 2 + 1 } });
        pass.setPipeline(test === 2 ? cleanPipeline! : pipeline);
        const timedGroup = test === 2 ? device.createBindGroup({layout:cleanPipeline!.getBindGroupLayout(0), entries:[
          {binding:0,resource:{buffer:output}}, {binding:5,resource:{buffer:materialBuffer}}, {binding:9,resource:{buffer:spectra}},
        ]}) : group;
        pass.setBindGroup(0, timedGroup);
        for (let repeat = 0; repeat < 4; repeat++) pass.dispatchWorkgroups(count / 64, 1);
        pass.end(); device.queue.submit([encoder.finish()]);
      }
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(queries, 0, 6, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, times, 0, 48); device.queue.submit([encoder.finish()]);
      await times.mapAsync(GPUMapMode.READ);
      const stamps = new BigUint64Array(times.getMappedRange());
      gpuMs = { clean: Number(stamps[1]! - stamps[0]!) / 4e6, worn: Number(stamps[3]! - stamps[2]!) / 4e6, specializedClean: Number(stamps[5]!-stamps[4]!)/4e6 };
      times.unmap();
    }
    return { name, compileMs, gpuMs, results, cleanDifference, seedDifference, transformRoughness, transformNormal, seedChanges, unrelatedSeedDifferences, scaleChanges, variantDifferences, physicalRoughness, physicalNormal };
  } finally { queries?.destroy(); timingBuffers.forEach(buffer => buffer.destroy()); materialBuffer.destroy(); output.destroy(); spectra.destroy(); readback.destroy(); device.destroy(); }
}
