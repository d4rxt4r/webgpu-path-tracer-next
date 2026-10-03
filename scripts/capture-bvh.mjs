import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const server = await createServer({
  server: { host: "127.0.0.1", port: 5325, strictPort: true, hmr: false },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5325/?scene=control");
  await page.locator("#pause:not([disabled])").waitFor();
  await page.locator("#pause").click();
  const result = await page.evaluate(async () => {
    const { IntersectionRenderer } = await import(
      "/src/render/intersection-renderer.ts"
    );
    const { suzanneScene } = await import("/src/scene/suzanne.ts");
    const { verifyOcclusion } = await import("/src/debug/verify-occlusion.ts");
    const numeric = await verifyOcclusion();
    const scene = await suzanneScene(),
      canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;left:0;top:0;width:320px;height:240px";
    document.body.append(canvas);
    let stats;
    const errors = [],
      images = [];
    const renderer = new IntersectionRenderer(
      canvas,
      (info) => {
        stats = info;
      },
      (error) => errors.push(error.message),
    );
    const wait = async () => {
      const start = performance.now();
      while (
        (!stats || stats.presentedRevision !== stats.revision) &&
        performance.now() - start < 10000
      )
        await new Promise((r) => setTimeout(r, 10));
      if (stats.presentedRevision !== stats.revision || errors.length)
        throw new Error("BVH redraw failed");
    };
    try {
      renderer.pause();
      renderer.setDebugView("bvh");
      renderer.setSettings({ maxPixels: 76800 });
      await renderer.setScene(scene);
      await renderer.initialize();
      for (const side of numeric.sides) {
        renderer.setCamera({
          ...scene.camera,
          position: side.eye,
          up:
            side.name === "top" || side.name === "bottom"
              ? [0, 0, -1]
              : [0, 1, 0],
        });
        await wait();
        const png = await renderer.capturePng();
        images.push({
          name: side.name,
          bytes: Array.from(new Uint8Array(await png.arrayBuffer())),
        });
      }
    } finally {
      renderer.dispose();
      canvas.remove();
    }
    return { numeric, errors, images };
  });
  for (const image of result.images)
    await writeFile(
      `docs/validation/stage10-bvh-${image.name}.png`,
      Buffer.from(image.bytes),
    );
  await writeFile(
    "docs/validation/stage10-occlusion.json",
    JSON.stringify(
      {
        ...result.numeric,
        errors: result.errors,
        view: "BVH node visits within visible ray segment; walls remain opaque",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(result.numeric));
  if (result.errors.length || result.numeric.mismatches.length)
    throw new Error("BVH acceptance failed");
} finally {
  await browser?.close();
  await server.close();
}
