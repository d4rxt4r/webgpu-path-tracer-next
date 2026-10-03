import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { createServer } from "node:https";
import { chromium, firefox, expect } from "@playwright/test";

const argument = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const openssl = argument("--openssl") ?? "openssl";
const temporary = await mkdtemp(join(tmpdir(), "path-tracer-https-"));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command}: ${code}`)),
    );
  });
let https, vite;
const matrix = [],
  profiles = [];
try {
  await run(openssl, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(temporary, "key.pem"),
    "-out",
    join(temporary, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const root = resolve("dist");
  https = createServer(
    {
      key: await readFile(join(temporary, "key.pem")),
      cert: await readFile(join(temporary, "cert.pem")),
    },
    async (request, response) => {
      try {
        const pathname = decodeURIComponent(
          new URL(request.url, "https://localhost").pathname,
        );
        const file = resolve(
          root,
          `.${pathname === "/" ? "/index.html" : pathname}`,
        );
        if (!file.startsWith(root + "\\") && !file.startsWith(root + "/"))
          throw new Error("Outside root");
        const bytes = await readFile(file);
        response.setHeader(
          "Content-Type",
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".bin": "application/octet-stream",
          }[extname(file)] ?? "application/octet-stream",
        );
        response.end(bytes);
      } catch {
        response.statusCode = 404;
        response.end();
      }
    },
  );
  await new Promise((resolve) => https.listen(0, "127.0.0.1", resolve));
  const secureAddress = `https://127.0.0.1:${https.address().port}`;
  for (const [name, type, options] of [
    ["Chrome", chromium, { channel: "chrome" }],
    ["Edge", chromium, { channel: "msedge" }],
    ["Firefox", firefox, {}],
  ]) {
    let browser;
    try {
      browser = await type.launch(options);
      const page = await browser.newPage({
        ignoreHTTPSErrors: true,
        deviceScaleFactor: 2,
        viewport: { width: 1280, height: 800 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(secureAddress + "/?scene=control");
      await expect
        .poll(() => page.locator("#status").textContent(), { timeout: 30000 })
        .toMatch(/WebGPU готов|Ошибка/);
      const supported = await page.evaluate(async () =>
        Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
      );
      if (!supported) {
        matrix.push({
          name,
          version: browser.version(),
          status: "unsupported",
          secureContext: await page.evaluate(() => isSecureContext),
          error: await page.locator("#error").textContent(),
        });
        continue;
      }
      await expect(page.locator("#error")).toBeHidden();
      for (const view of ["normal", "depth", "bvh", "material"]) {
        await page.locator("#view").selectOption(view);
        await expect
          .poll(() => page.locator("canvas").getAttribute("data-frames"))
          .not.toBe("0");
      }
      await page.locator("#scene").evaluate((el) => {
        el.closest("details").open = true;
      });
      await page.locator("#scene").selectOption("suzanne");
      await expect(page.locator("#stats")).toContainText("98748", {
        timeout: 30000,
      });
      await expect
        .poll(() => page.locator("canvas").getAttribute("data-frames"))
        .not.toBe("0");
      await page.locator("#pause").click();
      const dimensions = await page
        .locator("canvas")
        .evaluate((canvas) => ({
          width: canvas.width,
          height: canvas.height,
          pageScroll: document.documentElement.scrollHeight > innerHeight,
        }));
      await page.screenshot({
        path: `docs/validation/stage10-${name.toLowerCase()}.png`,
      });
      if (errors.length || dimensions.pageScroll)
        throw new Error(`${name} runtime errors`);
      matrix.push({
        name,
        version: browser.version(),
        status: "passed",
        secureContext: await page.evaluate(() => isSecureContext),
        productionStaticHttps: true,
        scene: "Suzanne asset loaded and validated",
        certificate:
          "Temporary self-signed loopback certificate; TLS trust check bypassed by test",
        dimensions,
        stats: await page.locator("#stats").textContent(),
        errors,
      });
    } catch (error) {
      matrix.push({ name, status: "not-validated", error: error.message });
    } finally {
      await browser?.close();
    }
  }
  matrix.push({
    name: "Safari",
    status: "not-available",
    reason:
      "Windows host; Safari was not tested. Playwright WebKit is not Safari.",
  });
  // Profiling uses the production scheduler via a dev import, without competing renderers.
  const port = 5321,
    address = `http://127.0.0.1:${port}`;
  vite = spawn(
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
  const start = Date.now();
  while (true) {
    try {
      if ((await fetch(address)).ok) break;
    } catch {}
    if (vite.exitCode !== null || Date.now() - start > 10000)
      throw new Error("Vite failed");
    await new Promise((r) => setTimeout(r, 100));
  }
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(address + "/?scene=control");
    await page.locator("#pause:not([disabled])").waitFor();
    await page.locator("#pause").click();
    for (const profile of ["preview", "reference", "quality"]) {
      console.log(`Profiling ${profile}`);
      const result = await page.evaluate(async (profile) => {
        const { IntersectionRenderer } = await import(
          "/src/render/intersection-renderer.ts"
        );
        const { suzanneScene } = await import("/src/scene/suzanne.ts");
        const { profiles } = await import("/src/app/profiles.ts");
        const canvas = document.createElement("canvas");
        canvas.style.cssText =
          "position:fixed;top:0;left:0;width:640px;height:480px";
        document.body.append(canvas);
        let stats,
          done = false,
          started = 0;
        const portions = [],
          errors = [];
        const target =
          profile === "quality" ? 4 : profile === "preview" ? 16 : 4;
        const renderer = new IntersectionRenderer(
          canvas,
          (info) => {
            stats = info;
            if (
              started &&
              info.status === "ready" &&
              (info.samples > 0 || info.tile > 0 || info.batch > 0)
            )
              portions.push({
                completionMs: info.completionMs,
                gpuMs: info.gpuMs,
                nextPhase: info.phase,
              });
            if (info.samples === target && !done) {
              done = true;
              renderer.pause();
            }
          },
          (error) => {
            errors.push(error.message);
            done = true;
          },
        );
        try {
          renderer.setDebugView("beauty");
          renderer.setSettings({ ...profiles[profile], memoryBudgetMiB: 192 });
          renderer.setInteracting(profile === "preview");
          await renderer.setScene(await suzanneScene());
          started = performance.now();
          await renderer.initialize();
          while (!done && performance.now() - started < 180000)
            await new Promise((r) => setTimeout(r, 20));
          if (!done) throw new Error("Profiling timed out");
          const capture = await renderer.capture();
          const elapsedMs = performance.now() - started;
          const summarize = (field) => {
            const values = portions
              .map((p) => p[field])
              .filter(Number.isFinite)
              .sort((a, b) => a - b);
            return values.length
              ? {
                  count: values.length,
                  median: values[Math.floor(values.length / 2)],
                  p95: values[Math.floor((values.length - 1) * 0.95)],
                  max: values.at(-1),
                }
              : null;
          };
          return {
            profile,
            ...stats,
            elapsedMs,
            samples: capture.samples,
            sampleCountUniform: capture.sampleCounts.every((n) => n === target),
            portionCompletion: summarize("completionMs"),
            portionGpu: summarize("gpuMs"),
            portions,
            errors,
          };
        } finally {
          renderer.dispose();
          canvas.remove();
        }
      }, profile);
      profiles.push(result);
      console.log(
        `${profile}: ${result.elapsedMs.toFixed(0)} ms, ${result.bytes} bytes`,
      );
    }
  } finally {
    await browser.close();
  }
  const report = {
    date: new Date().toISOString(),
    matrix,
    profiles,
    interpretation:
      "GPU timestamps cover integrator commands only. Completion includes queue/readback and completed-frame display. Elapsed includes initialization and RAF scheduling; results are hardware/browser specific, not a guaranteed FPS.",
  };
  report.passed =
    ["Chrome", "Edge"].every((name) =>
      matrix.some((row) => row.name === name && row.status === "passed"),
    ) &&
    profiles.every(
      (p) =>
        p.errors.length === 0 &&
        p.sampleCountUniform &&
        p.bytes <= 192 * 1048576,
    );
  await writeFile(
    "docs/validation/stage10-runtime.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.passed)
    throw new Error("Runtime acceptance failed; inspect stage10-runtime.json");
} finally {
  vite?.kill();
  if (https) await new Promise((resolve) => https.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
