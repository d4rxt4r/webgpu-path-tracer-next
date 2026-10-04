import { expect, test } from "@playwright/test";

test("specialized Owen sampler equals the original GPU and independent CPU sampler", async ({
  page,
}) => {
  await page.route("**/sampler-host", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/sampler-host");
  const result = await page.evaluate(async () => {
    const deviceUrl = "/src/gpu/device.ts",
      sourceUrl = "/src/transport/sampler-source.ts";
    const assetUrl = "/src/assets/sobol.ts",
      cpuUrl = "/src/transport/sampler.ts";
    const { createDevice, checkedShader } = await import(
      /* @vite-ignore */ deviceUrl
    );
    const { referenceSamplerSource, sppmSamplerSource } = await import(
      /* @vite-ignore */ sourceUrl
    );
    const { loadSobol } = await import(/* @vite-ignore */ assetUrl);
    const { sobolSample } = await import(/* @vite-ignore */ cpuUrl);
    const { device } = await createDevice();
    const resources: GPUBuffer[] = [];
    try {
      const directions = new Uint32Array(await loadSobol());
      const records: number[] = [],
        expected: number[] = [];
      for (const seed of [1, 17, 29, 43, 71, 101, 127, 0xffffffff])
        for (const index of [
          0, 1, 2, 3, 17, 31, 255, 256, 1023, 65535, 1048575, 16777215,
          0xffffffff,
        ])
          for (const dimension of [0, 1, 6, 7, 224, 450])
            for (const pixel of [0, 17, 1023, 65535]) {
              records.push(index, dimension, pixel, seed);
              expected.push(
                sobolSample(index, dimension, pixel, seed, directions),
              );
            }
      const buffer = (size: number, usage: number, data?: Uint32Array) => {
        const value = device.createBuffer({
          size,
          usage,
          mappedAtCreation: !!data,
        });
        resources.push(value);
        if (data) {
          new Uint32Array(value.getMappedRange()).set(data);
          value.unmap();
        }
        return value;
      };
      const input = buffer(
        records.length * 4,
        GPUBufferUsage.STORAGE,
        Uint32Array.from(records),
      );
      const sobol = buffer(
        directions.byteLength,
        GPUBufferUsage.STORAGE,
        directions,
      );
      const outputs: Float32Array[] = [];
      for (const source of [referenceSamplerSource, sppmSamplerSource]) {
        const output = buffer(
          expected.length * 4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        );
        const readback = buffer(
          output.size,
          GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        );
        const module = await checkedShader(
          device,
          source +
            `
@group(0) @binding(0) var<storage, read> inputs: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> outputs: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&inputs)) { return; }
  let p = inputs[id.x]; outputs[id.x] = sample1D(p.x, p.y, p.z, p.w);
}`,
          "Owen sampler equivalence",
        );
        const pipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module, entryPoint: "main" },
        });
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: input } },
            { binding: 1, resource: { buffer: output } },
            { binding: 7, resource: { buffer: sobol } },
          ],
        });
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(expected.length / 64));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        outputs.push(new Float32Array(readback.getMappedRange()).slice());
        readback.unmap();
      }
      let gpuMismatches = 0,
        maxCpuError = 0;
      for (let i = 0; i < expected.length; i++) {
        if (outputs[0]![i] !== outputs[1]![i]) gpuMismatches++;
        maxCpuError = Math.max(
          maxCpuError,
          Math.abs(outputs[1]![i]! - expected[i]!),
        );
      }
      return { values: expected.length, gpuMismatches, maxCpuError };
    } finally {
      resources.forEach((resource) => resource.destroy());
      device.destroy();
    }
  });
  console.log("Specialized sampler acceptance:", JSON.stringify(result));
  expect(result.values).toBe(2496);
  expect(result.gpuMismatches).toBe(0);
  expect(result.maxCpuError).toBe(0);
});
