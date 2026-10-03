import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const reference = process.argv.includes("--reference");
const prefix = reference ? "reference-look" : "stage10-final";

const server = await createServer({
  server: { host: "127.0.0.1", port: 5323, strictPort: true, hmr: false },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5323/?scene=control");
  await page.locator("#pause:not([disabled])").waitFor();
  await page.locator("#pause").click();
  console.log(
    reference
      ? "Rendering reference presentation: 256x256, 1024 iterations"
      : "Rendering final raw and filtered Suzanne: 256x192, 2048 iterations",
  );
  const image = await page.evaluate(async (reference) => {
    const { renderSppm } = await import("/src/debug/render-sppm.ts");
    const { suzanneScene } = await import("/src/scene/suzanne.ts");
    const { presentationScene } = await import("/src/scene/presentation.ts");
    const { xyzToLinearRgb } = await import("/src/transport/spectrum.ts");
    const options = {
      width: 256,
      height: reference ? 256 : 192,
      iterations: reference ? 1024 : 2048,
      checkpoints: reference
        ? [128, 256, 512, 1024]
        : [128, 256, 512, 1024, 2048],
      seed: reference ? 1 : 17,
      maxDepth: 32,
      initialRadius: 0.03,
      photonsPerIteration: 16384,
      photonBatchSize: 4096,
      denoise: { enabled: true, passes: 3, strength: 2, filterGlass: false },
    };
    const start = performance.now();
    const result = await renderSppm(
      await (reference ? presentationScene() : suzanneScene()),
      options,
    );
    const rgb = (pixels) => {
      const out = [];
      for (let i = 0; i < pixels.length; i += 3)
        out.push(...xyzToLinearRgb(pixels.slice(i, i + 3)));
      return out;
    };
    const raw = rgb(result.pixels),
      filtered = rgb(result.filtered);
    const png = (pixels) => {
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d"),
        data = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < canvas.width * canvas.height; i++) {
        for (let c = 0; c < 3; c++) {
          const v = Math.max(0, pixels[i * 3 + c]),
            tone = v / (1 + v);
          data.data[i * 4 + c] = Math.round(
            255 *
              (tone <= 0.0031308
                ? 12.92 * tone
                : 1.055 * tone ** (1 / 2.4) - 0.055),
          );
        }
        data.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
      return canvas.toDataURL().split(",")[1];
    };
    let deltaSquared = 0,
      rawMean = 0,
      filteredMean = 0;
    for (let i = 0; i < raw.length; i += 3) {
      const y = (p) =>
        0.2126729 * p[i] + 0.7151522 * p[i + 1] + 0.072175 * p[i + 2];
      const a = y(raw),
        b = y(filtered);
      rawMean += a;
      filteredMean += b;
      deltaSquared += (a - b) ** 2;
    }
    return {
      width: result.width,
      height: result.height,
      raw,
      rawPng: png(raw),
      filteredPng: png(filtered),
      metadata: {
        options,
        convergence: result.convergence,
        adapter: result.adapter,
        errors: result.errors,
        emittedPhotons: result.emittedPhotons,
        elapsedMs: performance.now() - start,
        allSamplesComplete: result.counts.every(
          (n) => n === options.iterations,
        ),
        displayLuminanceDeltaRmse: Math.sqrt(
          deltaSquared / (result.width * result.height),
        ),
        rawMean: rawMean / (result.width * result.height),
        filteredMean: filteredMean / (result.width * result.height),
        interpretation:
          "Actual GPU spatial denoiser; PNG uses exposure 0, Reinhard and sRGB. Delta to raw measures display change, not error against a ground truth. Raw f32 is exported separately.",
      },
    };
  }, reference);
  const data = Buffer.alloc(image.width * image.height * 12);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      for (let c = 0; c < 3; c++)
        data.writeFloatLE(
          image.raw[((image.height - 1 - y) * image.width + x) * 3 + c],
          (y * image.width + x) * 12 + c * 4,
        );
  await writeFile(
    `docs/validation/${prefix}.pfm`,
    Buffer.concat([
      Buffer.from(`PF\n${image.width} ${image.height}\n-1.0\n`),
      data,
    ]),
  );
  await writeFile(
    `docs/validation/${prefix}-raw.png`,
    Buffer.from(image.rawPng, "base64"),
  );
  await writeFile(
    `docs/validation/${prefix}-filtered.png`,
    Buffer.from(image.filteredPng, "base64"),
  );
  await writeFile(
    `docs/validation/${prefix}.json`,
    JSON.stringify(image.metadata, null, 2) + "\n",
  );
  console.log(JSON.stringify(image.metadata));
  if (image.metadata.errors || !image.metadata.allSamplesComplete)
    throw new Error("Final capture failed");
} finally {
  await browser?.close();
  await server.close();
}
