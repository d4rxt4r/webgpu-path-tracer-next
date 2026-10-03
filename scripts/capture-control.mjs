import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// GPU regression artifact, not an independent transport reference.
const glass = process.argv.includes('--glass');
const stage = glass ? 4 : 3;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5175', '--strictPort'], { stdio: 'ignore', windowsHide: true });
let browser;
try {
  const started = Date.now();
  while (true) {
    try { if ((await fetch('http://127.0.0.1:5175')).ok) break; } catch { /* Waiting for Vite. */ }
    if (server.exitCode !== null || Date.now() - started > 10000) throw new Error('Control capture server did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:5175');
  await page.locator('#status').filter({ hasText: 'WebGPU готов' }).waitFor();
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const result = await page.evaluate(async ({ glass, stage }) => {
    const rendererUrl = '/src/render/intersection-renderer.ts', sceneUrl = '/src/scene/cornell.ts';
    const { IntersectionRenderer } = await import(rendererUrl);
    const { cornellScene } = await import(sceneUrl);
    const canvas = document.createElement('canvas'); canvas.id = 'control-canvas'; canvas.style.cssText = 'width:128px;height:96px'; document.body.append(canvas);
    let lastStats, stopped = false, failure;
    const renderer = new IntersectionRenderer(canvas, stats => {
      lastStats = stats;
      if (stats.samples === 128 && !stopped) { stopped = true; renderer.pause(); }
    }, error => { failure = error; });
    renderer.setDebugView('beauty'); renderer.setSettings({ maxPixels: 128 * 96, seed: 17, maxDepth: glass ? 32 : 8 });
    const scene = cornellScene(glass ? 'glass' : 'diffuse');
    await renderer.setScene(scene);
    const started = performance.now(); await renderer.initialize();
    while (!stopped && !failure && performance.now() - started < 30000) await new Promise(resolve => setTimeout(resolve, 20));
    if (failure || !stopped) { renderer.dispose(); throw failure ?? new Error('Control capture timed out'); }
    const capture = await renderer.capture();
    if (!capture.sampleCounts.every(value => value === 128)) throw new Error('Incomplete sample sweep');
    const { linearRgb, sampleCounts, ...metadata } = capture;
    return { pixels: Array.from(linearRgb), metadata: { ...metadata, scene: glass ? 'cornell-glass-sphere' : 'cornell-diffuse-sphere', stage, referenceKind: 'GPU regression capture', adapter: lastStats.adapter, managedBytes: lastStats.bytes, elapsedMs: performance.now() - started } };
  }, { glass, stage });
  const directory = new URL('../docs/validation/', import.meta.url); await mkdir(directory, { recursive: true });
  await page.locator('#control-canvas').screenshot({ path: fileURLToPath(new URL(`stage${stage}-cornell.png`, directory)) });
  const { width, height } = result.metadata;
  const pixels = Buffer.alloc(width * height * 12);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) pixels.writeFloatLE(result.pixels[((height - 1 - y) * width + x) * 3 + channel], (y * width + x) * 12 + channel * 4);
  await writeFile(new URL(`stage${stage}-cornell.pfm`, directory), Buffer.concat([Buffer.from(`PF\n${width} ${height}\n-1.0\n`), pixels]));
  await writeFile(new URL(`stage${stage}-cornell.json`, directory), JSON.stringify(result.metadata, null, 2) + '\n');
  console.log(JSON.stringify(result.metadata));
} finally { await browser?.close(); server.kill(); }
