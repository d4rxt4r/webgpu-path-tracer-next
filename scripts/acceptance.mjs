import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const argument = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const pbrt = argument("--pbrt");
const reuseReference = process.argv.includes("--reuse-reference");
if (!pbrt && !reuseReference)
  throw new Error("Provide --pbrt <PBRT v4 executable> or --reuse-reference");
const iterations = Number(argument("--iterations") ?? 2048);
const sourcePrefix = argument("--source") ?? "/src";
const baselineOnly = process.argv.includes("--baseline-only");
const spp = Number(argument("--reference-spp") ?? 32768);
if (![iterations, spp].every((n) => Number.isInteger(n) && n > 0))
  throw new Error("Invalid sample count");
const referenceDirectory = resolve(
  fileURLToPath(new URL("../docs/validation/", import.meta.url)),
);
const directory = argument("--output")
  ? resolve(argument("--output"))
  : referenceDirectory;
if (
  reuseReference &&
  directory.toLowerCase() === referenceDirectory.toLowerCase()
)
  throw new Error("Use --output to preserve the existing acceptance artifacts");
await mkdir(directory, { recursive: true });
const run = (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${executable}: ${code}: ${stderr}`)),
    );
  });
const parse = (buffer) => {
  let offset = 0;
  const line = () => {
    const end = buffer.indexOf(10, offset);
    const s = buffer.toString("ascii", offset, end).trim();
    offset = end + 1;
    return s;
  };
  if (line() !== "PF") throw new Error("Expected RGB PFM");
  const [width, height] = line().split(/\s+/).map(Number),
    scale = Number(line());
  if (scale >= 0 || buffer.length - offset !== width * height * 12)
    throw new Error("Invalid little-endian PFM");
  const pixels = Array.from({ length: width * height * 3 }, (_, i) => {
    const pixel = Math.floor(i / 3),
      x = pixel % width,
      y = Math.floor(pixel / width);
    return (
      buffer.readFloatLE(
        offset + ((height - 1 - y) * width + x) * 12 + (i % 3) * 4,
      ) * Math.abs(scale)
    );
  });
  return { width, height, pixels };
};
const writePfm = async (image, filename) => {
  const buffer = Buffer.alloc(image.width * image.height * 12);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      for (let c = 0; c < 3; c++)
        buffer.writeFloatLE(
          image.pixels[((image.height - 1 - y) * image.width + x) * 3 + c],
          (y * image.width + x) * 12 + c * 4,
        );
  await writeFile(
    `${directory}/${filename}`,
    Buffer.concat([
      Buffer.from(`PF\n${image.width} ${image.height}\n-1.0\n`),
      buffer,
    ]),
  );
};
const luminance = (p, i) =>
  0.2126729 * p[i] + 0.7151522 * p[i + 1] + 0.072175 * p[i + 2];
const rois = {
  floor: [0.35, 0.65, 0.8, 0.95],
  room: [0.25, 0.75, 0.2, 0.9],
  glass: [0.3, 0.7, 0.35, 0.7],
};
const mean = (image, roi) => {
  let sum = 0,
    count = 0;
  for (
    let y = Math.floor(image.height * roi[2]);
    y < Math.floor(image.height * roi[3]);
    y++
  )
    for (
      let x = Math.floor(image.width * roi[0]);
      x < Math.floor(image.width * roi[1]);
      x++
    ) {
      sum += luminance(image.pixels, (y * image.width + x) * 3);
      count++;
    }
  return sum / count;
};
const compare = (image, reference) => {
  let squared = 0;
  for (let i = 0; i < image.pixels.length; i += 3)
    squared +=
      (luminance(image.pixels, i) - luminance(reference.pixels, i)) ** 2;
  return {
    luminanceRmse: Math.sqrt(squared / (image.width * image.height)),
    regions: Object.fromEntries(
      Object.entries(rois).map(([name, roi]) => {
        const value = mean(image, roi),
          expected = mean(reference, roi);
        return [
          name,
          {
            roi,
            mean: value,
            referenceMean: expected,
            relativeError: Math.abs(value / expected - 1),
          },
        ];
      }),
    ),
  };
};
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const address = `http://127.0.0.1:${port}`;
const server = spawn(
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
    if (server.exitCode !== null || Date.now() - start > 10000)
      throw new Error("Vite failed");
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto(`${address}/?scene=control`);
  await page.locator("#pause:not([disabled])").waitFor();
  await page.locator("#pause").click();
  const width = 32,
    height = 24,
    seeds = [17, 29];
  const source = await page.evaluate(
    async ({ width, height, spp, sourcePrefix }) => {
      const { suzanneScene } = await import(`${sourcePrefix}/scene/suzanne.ts`);
      const { exportPbrt } = await import(
        `${sourcePrefix}/debug/export-pbrt.ts`
      );
      return exportPbrt(
        await suzanneScene(),
        width,
        height,
        spp,
        "stage10-pbrt-17.pfm",
        64,
      );
    },
    { width, height, spp, sourcePrefix },
  );
  if (!reuseReference) {
    await writeFile(`${directory}/stage10-suzanne.pbrt`, source);
    await writeFile(`${directory}/stage10-suzanne.pbrt.gz`, gzipSync(source));
  }
  const referencesPromise = Promise.all(
    seeds.map(async (seed) => {
      if (reuseReference) {
        const previous = JSON.parse(
          await readFile(`${referenceDirectory}/stage10-quality.json`, "utf8"),
        );
        if (
          previous.sourceSha256 !==
            createHash("sha256").update(source).digest("hex") ||
          previous.pbrtSamplesPerPixel !== spp
        )
          throw new Error(
            "Stored PBRT reference does not match the exported scene/sample count",
          );
        return parse(
          await readFile(`${referenceDirectory}/stage10-pbrt-${seed}.pfm`),
        );
      }
      console.log(`PBRT Suzanne: ${spp} spp, seed ${seed}`);
      await run(pbrt, [
        "--quiet",
        "--nthreads",
        "4",
        "--seed",
        String(seed),
        "--outfile",
        `stage10-pbrt-${seed}.pfm`,
        "stage10-suzanne.pbrt",
      ]);
      return parse(await readFile(`${directory}/stage10-pbrt-${seed}.pfm`));
    }),
  );
  // Observe failures immediately while GPU work runs, then inspect all results below.
  referencesPromise.catch(() => {});
  const results = [];
  for (const [name, maxDepth, initialRadius] of [
    ["baseline", 32, 0.03],
    ["depth64", 64, 0.03],
    ["radius006", 32, 0.06],
  ]) {
    if (baselineOnly && name !== "baseline") continue;
    console.log(`GPU Suzanne ${name}: ${iterations} iterations`);
    const result = await page.evaluate(
      async (options) => {
        const { renderSppm } = await import(
          `${options.sourcePrefix}/debug/render-sppm.ts`
        );
        const { suzanneScene } = await import(
          `${options.sourcePrefix}/scene/suzanne.ts`
        );
        const started = performance.now();
        const image = await renderSppm(await suzanneScene(), options);
        const { xyzToLinearRgb } = await import(
          `${options.sourcePrefix}/transport/spectrum.ts`
        );
        const rgb = [];
        for (let i = 0; i < image.pixels.length; i += 3)
          rgb.push(...xyzToLinearRgb(image.pixels.slice(i, i + 3)));
        return {
          ...image,
          pixels: rgb,
          elapsedMs: performance.now() - started,
        };
      },
      {
        width,
        height,
        iterations,
        maxDepth,
        initialRadius,
        seed: 17,
        photonsPerIteration: 8192,
        photonBatchSize: 4096,
        sourcePrefix,
      },
    );
    await writePfm(result, `stage10-${name}.pfm`);
    results.push({ name, maxDepth, initialRadius, ...result });
    console.log(
      `${name} complete: ${(result.elapsedMs / 1000).toFixed(1)} s, errors ${result.errors}`,
    );
  }
  const references = await referencesPromise;
  const reference = {
    width,
    height,
    pixels: references[0].pixels.map(
      (v, i) => (v + references[1].pixels[i]) / 2,
    ),
  };
  await writePfm(reference, "stage10-reference.pfm");
  const referenceSpread = Object.fromEntries(
    Object.entries(rois).map(([name, roi]) => [
      name,
      Math.abs(mean(references[0], roi) - mean(references[1], roi)) /
        mean(reference, roi),
    ]),
  );
  const metrics = results.map(({ pixels, counts, ...result }) => ({
    ...result,
    ...compare({ width, height, pixels }, reference),
  }));
  const report = {
    width,
    height,
    iterations,
    photonsPerIteration: 8192,
    photonBatchSize: 4096,
    seed: 17,
    pbrtSamplesPerPixel: spp,
    pbrtSeeds: seeds,
    pbrtDepth: 64,
    pbrtCommit: "b4ce9687e6c695f5582997c61b0c66cf064bdb4a",
    referenceReused: reuseReference,
    sourcePrefix,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    referenceSpread,
    metrics,
    depthComparison: baselineOnly ? undefined : compare(results[1], results[0]),
    radiusComparison: baselineOnly
      ? undefined
      : compare(results[2], results[0]),
    elapsedMs: Date.now() - start,
    limits:
      "Two reference seeds measure empirical stability, not a confidence bound. Low resolution numerical validation is separate from final image inspection.",
  };
  report.passed =
    results.every(
      (r) => r.errors === 0 && r.counts.every((n) => n === iterations),
    ) &&
    referenceSpread.floor <= 0.02 &&
    metrics[0].regions.floor.relativeError <= 0.05;
  await writeFile(
    `${directory}/stage10-quality.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (!report.passed)
    throw new Error(
      "Final-scene numerical acceptance failed; inspect stage10-quality.json",
    );
} finally {
  await browser?.close();
  server.kill();
}
