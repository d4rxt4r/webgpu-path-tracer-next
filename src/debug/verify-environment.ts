import { checkedShader, createDevice } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { GpuEnvironment } from '../gpu/environment';
import { defaultEnvironment } from '../scene/environment';
import { cornellScene } from '../scene/cornell';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { packBvh } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { pathCore } from '../transport/shaders';
import { loadSobol } from '../assets/sobol';
import { hdrDistribution, type HdrImage } from '../assets/hdr';
import { rgbIlluminantSpectrum } from '../transport/environment-spectrum';

/** Independent GPU acceptance: Lambertian plane under unit uniform radiance. */
export async function verifyEnvironment(): Promise<{ means: number[]; expected: number; errors: number; primary: number[] }> {
  const { device } = await createDevice(); const buffers: GPUBuffer[] = [];
  const description = cornellScene('diffuse');
  description.objects.forEach((object, index) => { object.visible = index === 0; }); description.lights = [];
  const floor = description.materials[0]!; if (floor.type !== 'diffuse') throw new Error('Missing floor');
  floor.reflectance = [.5, .5, .5]; floor.spectrum = [[360, .5], [830, .5]];
  const bvh = buildBvh(bakeTriangles(description)), packed = { ...packBvh(bvh), ...packTransport(description, bvh) };
  const environment = new GpuEnvironment(device); environment.setScene(packed); environment.update({ ...defaultEnvironment, source: 'color' });
  const scene = new GpuScene(device, packed, environment);
  const count = 8192;
  const buffer = (size: number, usage: number) => { const value = device.createBuffer({ size, usage }); buffers.push(value); return value; };
  try {
    const sobolData = await loadSobol();
    const sobol = buffer(sobolData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST); device.queue.writeBuffer(sobol, 0, sobolData);
    const output = buffer(count * 3 * 16 + 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const module = await checkedShader(device, pathCore + `
@group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=${count}u) {return;}
  for(var strategy=0u;strategy<3u;strategy++) {
    let path=tracePath(Ray(vec3f(0,.5,0),.00001,vec3f(0,-1,0),1e20),id.x,17u,1u,1u,strategy,0u);
    result[strategy*${count}u+id.x]=vec4f(path.radiance,f32(path.error));
  }
  if(id.x==0u) {result[${count * 3}u]=vec4f(environmentRadiance(vec3f(0,1,0),0.0,true),0);}
}`, 'Environment energy acceptance');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, ...scene.entries(), ...scene.transportEntries(true), { binding: 7, resource: { buffer: sobol } }, scene.spectralEntry()] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count / 64); pass.end(); encoder.copyBufferToBuffer(output, 0, readback, 0, output.size); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()), means = [0, 0, 0]; let errors = 0;
    for (let strategy = 0; strategy < 3; strategy++) for (let i = 0; i < count; i++) { const offset = (strategy * count + i) * 4; means[strategy] = means[strategy]! + values[offset]! / count; errors += Number(values[offset + 3] !== 0); }
    const primary = [...values.slice(count * 3 * 4, count * 3 * 4 + 3)]; readback.unmap();
    return { means, expected: .5, errors, primary };
  } finally { buffers.forEach(buffer => buffer.destroy()); scene.dispose(); environment.dispose(); device.destroy(); }
}

/** Small kernel validates the texture-backed CDF and RGB spectral conversion. */
export async function verifyEnvironmentMap(): Promise<{ pdfError: number; spectrumError: number; whiteY: number; sampledMean: number; integral: number }> {
  const { device } = await createDevice();
  const image: HdrImage = { width: 8, height: 4, pixels: new Float32Array(8 * 4 * 4) };
  for (let i = 0; i < image.pixels.length; i += 4) { image.pixels[i] = i === 0 ? 100 : .1; image.pixels[i + 1] = .2; image.pixels[i + 2] = .3; image.pixels[i + 3] = 1; }
  const distribution = hdrDistribution(image), environment = new GpuEnvironment(device, image); environment.update({ ...defaultEnvironment, source: 'hdr' });
  const count = 4096;
  const output = device.createBuffer({ size: (count + 471) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const module = await checkedShader(device, pathCore + `
@group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x<${count}u) {
    let u=vec3f((f32(id.x)+.5)/${count}.0,(f32(hash32(id.x))+.5)/4294967296.0,(f32(hash32(id.x^0x1234u))+.5)/4294967296.0);
    let light=sampleEnvironment(u,0.0);
    let uv=environmentUv(light.direction);
    result[id.x]=vec4f(uv,light.pdf,dot(light.radiance,vec3f(.2126,.7152,.0722))/light.pdf);
  }
  if(id.x<471u) {
    let wavelength=360.0+f32(id.x);
    result[${count}u+id.x]=vec4f(environmentSpectrum(vec3f(1),wavelength).x,environmentSpectrum(vec3f(.2,.6,1),wavelength).x,0,0);
  }
}`, 'Environment CDF and spectrum acceptance');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, ...environment.entries()] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count / 64); pass.end(); encoder.copyBufferToBuffer(output, 0, readback, 0, output.size); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ); const values = new Float32Array(readback.getMappedRange());
    let pdfError = 0, spectrumError = 0, sampledMean = 0;
    const white: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const x = Math.min(7, Math.floor(values[i * 4]! * 8)), y = Math.min(3, Math.floor(values[i * 4 + 1]! * 4));
      pdfError = Math.max(pdfError, Math.abs(values[i * 4 + 2]! - distribution.pixels[(y * 8 + x) * 4 + 2]!)); sampledMean += values[i * 4 + 3]! / count;
    }
    for (let i = 0; i < 471; i++) {
      white.push([360 + i, values[(count + i) * 4]!]);
      spectrumError = Math.max(spectrumError, Math.abs(values[(count + i) * 4 + 1]! - rgbIlluminantSpectrum([.2, .6, 1], 360 + i)));
    }
    readback.unmap();
    const { integrateXyz } = await import('../transport/spectrum');
    return { pdfError, spectrumError, whiteY: integrateXyz(white)[1], sampledMean, integral: distribution.integral };
  } finally { output.destroy(); readback.destroy(); environment.dispose(); device.destroy(); }
}
