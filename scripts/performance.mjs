import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";

const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const tag = option("tag", "current");
if (!/^[a-z0-9-]+$/i.test(tag)) throw Error("Invalid report tag");
const width = Number(option("width", 160)),
  height = Number(option("height", 120));
const repeats = Number(option("repeats", 5));
const ptSamples = Number(option("pt", 16)),
  sppmSamples = Number(option("sppm", 8));
const seeds = option("seeds", "17").split(",").map(Number);
const requested = option(
  "cases",
  "sphere,suzanne,buddha-glass,buddha-marble,buddha-lava",
).split(",");
const modes = option(
  "modes",
  "rgb-pt,spectral-pt,rgb-sppm,spectral-sppm",
).split(",");
const source = option("source", "/src");
const images = option("images", "yes") === "yes";
const candidate = option("candidate", "none");
const workgroup = option("workgroup", "8,8").split(",").map(Number);
const leaf = Number(option("leaf", 4));
const tileSize = Number(option("tile", 0));
const referenceFile = option("reference", "");
if (
  ![width, height, repeats, ptSamples, sppmSamples].every(
    (n) => Number.isInteger(n) && n > 0,
  ) ||
  !seeds.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff) ||
  !Number.isInteger(leaf) ||
  leaf < 1 ||
  leaf > 16 ||
  !Number.isInteger(tileSize) ||
  tileSize < 0 ||
  tileSize > 256 ||
  workgroup.length !== 2 ||
  !workgroup.every((n) => Number.isInteger(n) && n > 0) ||
  workgroup[0] * workgroup[1] > 256
)
  throw Error(
    "Invalid dimensions, sample count, seed, leaf, tile or workgroup",
  );
if (
  !requested.every((name) =>
    [
      "sphere",
      "suzanne",
      "buddha-glass",
      "buddha-marble",
      "buddha-lava",
    ].includes(name),
  ) ||
  !modes.every((mode) =>
    ["rgb-pt", "spectral-pt", "rgb-sppm", "spectral-sppm"].includes(mode),
  )
)
  throw Error("Unknown scene or mode");
if (
  ![
    "none",
    "compact-triangles",
    "reciprocal-bounds",
    "cached-bounds",
    "bvh4",
    "csr",
    "wavefront",
  ].includes(candidate)
)
  throw Error("Unknown performance candidate");
if (["compact-triangles", "bvh4"].includes(candidate) && images)
  throw Error("This layout experiment requires --images no");
if (candidate === "wavefront" && !tileSize)
  throw Error("Wavefront requires an explicit --tile size");
if (["wavefront", "csr"].includes(candidate) && source !== "/src")
  throw Error("These prototypes require the current /src layout");
const sourceRoot = resolve(source.slice(1));
const sourceHash = createHash("sha256");
for (const name of (await readdir(sourceRoot, { recursive: true }))
  .filter((name) => /\.(ts|wgsl|json)$/.test(name))
  .sort()) {
  sourceHash.update(name);
  sourceHash.update(await readFile(join(sourceRoot, name)));
}
const sourceSha256 = sourceHash.digest("hex");
function parsePfm(data, width, height) {
  let offset = 0;
  const line = () => {
    const end = data.indexOf(10, offset),
      value = data.toString("ascii", offset, end).trim();
    offset = end + 1;
    return value;
  };
  if (line() !== "PF") throw Error("Expected RGB PFM");
  const [rw, rh] = line().split(/\s+/).map(Number),
    scale = Number(line());
  if (
    rw !== width ||
    rh !== height ||
    !(scale < 0) ||
    data.length - offset !== width * height * 12
  )
    throw Error("Reference PFM dimensions/endianness mismatch");
  return Array.from(
    { length: width * height * 3 },
    (_, i) =>
      data.readFloatLE(
        offset +
          ((height - 1 - Math.floor(i / 3 / width)) * width +
            (Math.floor(i / 3) % width)) *
            12 +
          (i % 3) * 4,
      ) * Math.abs(scale),
  );
}
const reference = referenceFile
  ? parsePfm(await readFile(referenceFile), width, height)
  : undefined;
const directory = `docs/validation/performance-${tag}`;
await mkdir(directory, { recursive: true });
const port = Number(option("port", 5331)),
  address = `http://127.0.0.1:${port}`;
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let browser;
try {
  const start = Date.now();
  while (true) {
    try {
      if ((await fetch(address)).ok) break;
    } catch {}
    if (vite.exitCode !== null || Date.now() - start > 15000)
      throw Error("Vite failed");
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: option("browser", "chrome") });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 800 },
  });
  // Load modules from a same-origin empty page; there is no competing app renderer.
  await page.route("**/performance-host", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto(address + "/performance-host");
  const capabilities = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw Error("No hardware WebGPU adapter");
    return {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      description: adapter.info.description,
      fallback: adapter.info.isFallbackAdapter,
      features: [...adapter.features],
    };
  });
  const rows = [];
  const baselineTag = option("compare", "");
  if (baselineTag && !/^[a-z0-9-]+$/i.test(baselineTag))
    throw Error("Invalid comparison tag");
  const baselineReport = baselineTag
    ? JSON.parse(
        await readFile(
          `docs/validation/performance-${baselineTag}/report.json`,
          "utf8",
        ),
      )
    : undefined;
  for (const scene of requested)
    for (const mode of modes)
      for (const seed of seeds) {
        const key = `${scene}-${mode}-${seed}`;
        const runs = [];
        for (let repeat = -1; repeat < repeats; repeat++) {
          const result = await page.evaluate(
            async ({
              scene,
              mode,
              seed,
              width,
              height,
              ptSamples,
              sppmSamples,
              save,
              source,
              images,
              candidate,
              workgroup,
              leaf,
              tileSize,
            }) => {
              const { IntersectionRenderer } = await import(
                `${source}/render/intersection-renderer.ts`
              );
              const { cornellScene } = await import(
                `${source}/scene/cornell.ts`
              );
              const { suzanneScene } = await import(
                `${source}/scene/suzanne.ts`
              );
              const { buddhaScene } = await import(`${source}/scene/buddha.ts`);
              const { encodePfm } = await import(`${source}/app/export.ts`);
              const [transport, integrator] = mode.split("-");
              const description =
                scene === "sphere"
                  ? cornellScene("nbk7")
                  : scene === "suzanne"
                    ? await suzanneScene()
                    : await buddhaScene(
                        scene.slice(7) === "glass" ? "nbk7" : scene.slice(7),
                      );
              const canvas = document.createElement("canvas");
              canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px`;
              document.body.append(canvas);
              const target = integrator === "pt" ? ptSamples : sppmSamples;
              let done = false,
                latest,
                renderedAt = 0;
              const errors = [],
                portions = [];
              const renderer = new IntersectionRenderer(
                canvas,
                (stats) => {
                  latest = stats;
                  if (
                    renderedAt &&
                    stats.status === "ready" &&
                    stats.completionMs > 0
                  )
                    portions.push({
                      completionMs: stats.completionMs,
                      gpuMs: stats.gpuMs,
                      executedPhase: stats.executedPhase,
                      steps: stats.packetSteps ?? 1,
                      count: stats.packetCount ?? 1,
                    });
                  if (stats.samples === target && !done) {
                    done = true;
                    renderer.pause();
                  }
                },
                (error) => {
                  errors.push(error.message);
                  done = true;
                },
              );
              if (tileSize) renderer.pathTileSize = tileSize;
              if (leaf !== 4) {
                const { buildBvh } = await import(`${source}/accel/bvh.ts`);
                const { bakeTriangles } = await import(
                  `${source}/accel/geometry.ts`
                );
                const { packBvh } = await import(`${source}/accel/pack.ts`);
                const { packTransport } = await import(
                  `${source}/accel/materials.ts`
                );
                renderer.preparer.prepare = async (description) => {
                  const bvh = buildBvh(bakeTriangles(description), 48, leaf);
                  return {
                    ...packBvh(bvh),
                    ...packTransport(description, bvh),
                  };
                };
              }
              try {
                renderer.setDebugView("beauty");
                renderer.setSettings({
                  mode: transport,
                  integrator,
                  maxDepth: 32,
                  maxPixels: width * height,
                  seed,
                  photonsPerIteration: 16384,
                  photonBatchSize: 1024,
                });
                const preparationStart = performance.now();
                await renderer.setScene(description);
                const preparationMs = performance.now() - preparationStart;
                const initializationStart = performance.now();
                await renderer.initialize();
                if (candidate === "wavefront") {
                  if (integrator !== "pt")
                    throw Error("Wavefront candidate requires PT");
                  renderer.pause();
                  const { installWavefrontCandidate } = await import(
                    "/scripts/performance-wavefront.mjs"
                  );
                  await installWavefrontCandidate(renderer);
                  renderer.resume();
                } else if (candidate === "csr") {
                  if (integrator !== "sppm")
                    throw Error("CSR candidate requires SPPM");
                  renderer.pause();
                  const { installCsrCandidate } = await import(
                    "/scripts/performance-csr.mjs"
                  );
                  await installCsrCandidate(renderer);
                  renderer.resume();
                } else if (
                  candidate !== "none" ||
                  workgroup[0] !== 8 ||
                  workgroup[1] !== 8
                ) {
                  if (integrator !== "pt")
                    throw Error("PT candidates require a PT case");
                  renderer.pause();
                  const { pathShader } = await import(
                    `${source}/transport/shaders.ts`
                  );
                  const { checkedShader } = await import(
                    `${source}/gpu/device.ts`
                  );
                  const { candidateShader, compactTriangles, wideNodes } =
                    await import("/scripts/performance-candidates.mjs");
                  const device = renderer.device;
                  const module = await checkedShader(
                    device,
                    candidateShader(pathShader, candidate),
                    candidate,
                  );
                  renderer.pathPipeline =
                    await device.createComputePipelineAsync({
                      layout: "auto",
                      compute: {
                        module,
                        entryPoint: "main",
                        constants: {
                          PT_WORKGROUP_X: workgroup[0],
                          PT_WORKGROUP_Y: workgroup[1],
                        },
                      },
                    });
                  renderer.pathWorkgroup = workgroup;
                  if (candidate === "bvh4") {
                    const data = wideNodes(renderer.packed.nodes);
                    renderer.scene.bytes +=
                      data.byteLength - renderer.scene.nodes.size;
                    renderer.scene.nodes.destroy();
                    renderer.scene.nodes = device.createBuffer({
                      size: data.byteLength,
                      usage: GPUBufferUsage.STORAGE,
                      mappedAtCreation: true,
                    });
                    new Uint32Array(renderer.scene.nodes.getMappedRange()).set(
                      data,
                    );
                    renderer.scene.nodes.unmap();
                    renderer.denoiser.configure = () => {};
                  }
                  if (candidate === "compact-triangles") {
                    renderer.scene.triangles.destroy();
                    const data = compactTriangles(renderer.packed.triangles);
                    renderer.scene.triangles = device.createBuffer({
                      size: data.byteLength,
                      usage: GPUBufferUsage.STORAGE,
                      mappedAtCreation: true,
                    });
                    new Uint32Array(
                      renderer.scene.triangles.getMappedRange(),
                    ).set(data);
                    renderer.scene.triangles.unmap();
                    // Debug/denoise use the reference layout and are intentionally bypassed.
                    renderer.denoiser.configure = () => {};
                  }
                  renderer.updateGroups();
                  renderer.resume();
                }
                const initializationMs =
                  performance.now() - initializationStart;
                renderedAt = performance.now();
                while (!done && performance.now() - renderedAt < 240000)
                  await new Promise((r) => setTimeout(r, 5));
                const elapsedMs = performance.now() - renderedAt;
                if (!done || errors.length)
                  throw Error(JSON.stringify({ errors, latest }));
                const capture = await renderer.capture();
                if (!capture.sampleCounts.every((n) => n === target))
                  throw Error("Nonuniform or overshot sample count");
                const artifacts = {};
                if (save) {
                  if (images) {
                    artifacts.pfm = Array.from(encodePfm(capture));
                    renderer.setDisplay({ enabled: false });
                    artifacts.rawPng = Array.from(
                      new Uint8Array(
                        await (await renderer.capturePng()).arrayBuffer(),
                      ),
                    );
                    renderer.setDisplay({
                      enabled: true,
                      passes: 3,
                      strength: 2,
                      filterGlass: false,
                    });
                    artifacts.filteredPng = Array.from(
                      new Uint8Array(
                        await (await renderer.capturePng()).arrayBuffer(),
                      ),
                    );
                  }
                  artifacts.raw = Array.from(capture.linearRgb);
                }
                return {
                  preparationMs,
                  initializationMs,
                  elapsedMs,
                  gpuMs: portions.reduce((sum, p) => sum + (p.gpuMs ?? 0), 0),
                  completionMs: portions.reduce(
                    (sum, p) => sum + p.completionMs,
                    0,
                  ),
                  submissions: portions.reduce((sum, p) => sum + p.count, 0),
                  portions,
                  bytes: latest.bytes,
                  samples: capture.samples,
                  emittedPhotons: capture.emittedPhotons,
                  width: capture.width,
                  height: capture.height,
                  settings: capture.settings,
                  computation: capture.computation,
                  errors,
                  artifacts,
                };
              } finally {
                renderer.dispose();
                canvas.remove();
              }
            },
            {
              scene,
              mode,
              seed,
              width,
              height,
              ptSamples,
              sppmSamples,
              save: repeat === 0,
              source,
              images,
              candidate,
              workgroup,
              leaf,
              tileSize,
            },
          );
          if (repeat < 0) continue;
          if (repeat === 0) {
            if (images)
              for (const [name, suffix] of [
                ["pfm", "pfm"],
                ["rawPng", "raw.png"],
                ["filteredPng", "filtered.png"],
              ])
                await writeFile(
                  `${directory}/${key}.${suffix}`,
                  Uint8Array.from(result.artifacts[name]),
                );
            await writeFile(
              `${directory}/${key}.raw.json`,
              JSON.stringify(result.artifacts.raw),
            );
            if (reference) {
              if (result.width !== width || result.height !== height)
                throw Error("Reference resolution differs from budgeted accumulation");
              const raw = result.artifacts.raw;
              const regions = {
                frame: [0, 1, 0, 1],
                floor: [0.35, 0.65, 0.8, 0.95],
                room: [0.25, 0.75, 0.2, 0.9],
                glass: [0.3, 0.7, 0.35, 0.7],
              };
              result.referenceMetrics = {};
              for (const [name, [x0, x1, y0, y1]] of Object.entries(regions)) {
                let square = 0,
                  sum = 0,
                  referenceSum = 0,
                  pixels = 0;
                for (
                  let y = Math.floor(height * y0);
                  y < Math.floor(height * y1);
                  y++
                )
                  for (
                    let x = Math.floor(width * x0);
                    x < Math.floor(width * x1);
                    x++
                  ) {
                    const i = (y * width + x) * 3;
                    let a = 0,
                      b = 0;
                    for (let c = 0; c < 3; c++) {
                      a += raw[i + c] * [0.2126729, 0.7151522, 0.072175][c];
                      b +=
                        reference[i + c] * [0.2126729, 0.7151522, 0.072175][c];
                    }
                    square += (a - b) ** 2;
                    sum += a;
                    referenceSum += b;
                    pixels++;
                  }
                result.referenceMetrics[name] = {
                  luminanceRmse: Math.sqrt(square / pixels),
                  meanY: sum / pixels,
                  referenceMeanY: referenceSum / pixels,
                  relativeMeanError: sum / referenceSum - 1,
                };
              }
            }
            if (baselineTag) {
              const oldRun = baselineReport.rows.find((row) => row.key === key)
                ?.runs[0];
              if (
                !oldRun ||
                oldRun.width !== result.width ||
                oldRun.height !== result.height
              )
                throw Error("Comparison resolution/case mismatch");
              let before;
              try {
                before = JSON.parse(
                  await readFile(
                    `docs/validation/performance-${baselineTag}/${key}.raw.json`,
                    "utf8",
                  ),
                );
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
                before = parsePfm(
                  await readFile(
                    `docs/validation/performance-${baselineTag}/${key}.pfm`,
                  ),
                  result.width,
                  result.height,
                );
              }
              const after = result.artifacts.raw;
              if (before.length !== after.length)
                throw Error("Comparison resolution mismatch");
              let square = 0,
                energy = 0,
                max = 0,
                sumBefore = 0,
                sumAfter = 0;
              const roi = {};
              const width = result.width,
                height = result.height;
              const diff = Buffer.alloc(width * height * 3);
              for (let pixel = 0; pixel < width * height; pixel++) {
                const x = pixel % width,
                  y = Math.floor(pixel / width);
                const regions = [
                  "frame",
                  ...(y > height * 0.65 && x > width * 0.2 && x < width * 0.8
                    ? ["floor"]
                    : []),
                  ...(x > width * 0.3 &&
                  x < width * 0.7 &&
                  y > height * 0.25 &&
                  y < height * 0.7
                    ? ["object"]
                    : []),
                ];
                let lumBefore = 0,
                  lumAfter = 0;
                for (let c = 0; c < 3; c++) {
                  const i = pixel * 3 + c,
                    delta = after[i] - before[i];
                  square += delta * delta;
                  energy += before[i] * before[i];
                  max = Math.max(max, Math.abs(delta));
                  sumBefore += before[i];
                  sumAfter += after[i];
                  lumBefore += before[i] * [0.2126, 0.7152, 0.0722][c];
                  lumAfter += after[i] * [0.2126, 0.7152, 0.0722][c];
                  diff[i] = Math.min(
                    255,
                    Math.round(Math.abs(delta) * 255 * 16),
                  );
                }
                for (const name of regions) {
                  const r = (roi[name] ??= { before: 0, after: 0, pixels: 0 });
                  r.before += lumBefore;
                  r.after += lumAfter;
                  r.pixels++;
                }
              }
              result.imageDifference = {
                maxAbsolute: max,
                rmse: Math.sqrt(square / after.length),
                normalizedRmse: Math.sqrt(square / Math.max(energy, 1e-30)),
                meanChange: sumAfter / sumBefore - 1,
                roi,
              };
              await writeFile(
                `${directory}/${key}.difference.ppm`,
                Buffer.concat([
                  Buffer.from(`P6\n${width} ${height}\n255\n`),
                  diff,
                ]),
              );
            }
          }
          delete result.artifacts;
          runs.push(result);
        }
        const summarize = (field) => {
          const values = runs.map((r) => r[field]).sort((a, b) => a - b);
          return {
            median: values[Math.floor(values.length / 2)],
            p95: values[Math.ceil(values.length * 0.95) - 1],
            min: values[0],
            max: values.at(-1),
          };
        };
        rows.push({
          key,
          scene,
          mode,
          seed,
          elapsed: summarize("elapsedMs"),
          preparation: summarize("preparationMs"),
          initialization: summarize("initializationMs"),
          runs,
        });
        console.log(
          `${key}: ${rows.at(-1).elapsed.median.toFixed(1)} ms, ${runs[0].submissions} submissions, difference ${runs[0].imageDifference?.normalizedRmse ?? "n/a"}`,
        );
        await writeFile(
          `${directory}/report.json`,
          JSON.stringify(
            {
              tag,
              commit: execFileSync("git", ["rev-parse", "HEAD"], {
                encoding: "utf8",
              }).trim(),
              sourceSha256,
              date: new Date().toISOString(),
              browser: browser.version(),
              capabilities,
              source,
              candidate,
              workgroup,
              leaf,
              tileSize,
              referenceFile,
              width,
              height,
              repeats,
              ptSamples,
              sppmSamples,
              rows,
            },
            null,
            2,
          ),
        );
      }
} finally {
  await browser?.close();
  vite.kill();
}
