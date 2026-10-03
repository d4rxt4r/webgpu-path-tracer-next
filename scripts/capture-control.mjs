import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// GPU regression artifact, not an independent transport reference.
const spectral = process.argv.includes('--spectral');
const sppm = process.argv.includes('--sppm');
const glass = sppm || spectral || process.argv.includes('--glass');
const stage = sppm && spectral ? 7 : sppm ? 6 : spectral ? 5 : glass ? 4 : 3;
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
  const result = await page.evaluate(async ({ glass, spectral, sppm, stage }) => {
    const rendererUrl = '/src/render/intersection-renderer.ts', sceneUrl = '/src/scene/cornell.ts';
    const { IntersectionRenderer } = await import(rendererUrl);
    const { cornellScene } = await import(sceneUrl);
    const canvas = document.createElement('canvas'); canvas.id = 'control-canvas'; canvas.style.cssText = 'width:128px;height:96px'; document.body.append(canvas);
    let lastStats, stopped = false, failure;
    const targets=sppm?(spectral?[8,16,32,64,128]:[8,16,32,64]):[128];let target=targets[0];
    const renderer = new IntersectionRenderer(canvas, stats => {
      lastStats = stats;
      if (stats.samples === target && !stopped) { stopped = true; renderer.pause(); }
    }, error => { failure = error; });
    renderer.setDebugView('beauty'); renderer.setSettings({ maxPixels: 128 * 96, seed: 17, maxDepth: glass ? 32 : 8, mode: spectral ? 'spectral' : 'rgb', integrator:sppm?'sppm':'pt' });
    const scene = cornellScene(spectral ? 'nbk7' : glass ? 'glass' : 'diffuse');
    await renderer.setScene(scene);
    const started = performance.now(); await renderer.initialize();
    let capture;const convergence=[];
    for(let i=0;i<targets.length;i++) {
      target=targets[i];if(i>0) {stopped=false;renderer.resume();}
      while (!stopped && !failure && performance.now() - started < (sppm?120000:30000)) await new Promise(resolve => setTimeout(resolve, 20));
      if (failure || !stopped) { renderer.dispose(); throw failure ?? new Error('Control capture timed out'); }
      capture = await renderer.capture();
      if (!capture.sampleCounts.every(value => value === target)) throw new Error('Incomplete sample sweep');
      if(sppm) {
        let mean=0,peak=0,count=0;
        for(let y=Math.floor(capture.height*0.8);y<Math.floor(capture.height*0.95);y++)for(let x=Math.floor(capture.width*0.35);x<Math.floor(capture.width*0.65);x++) {
          const p=(y*capture.width+x)*3,luma=0.2126*capture.linearRgb[p]+0.7152*capture.linearRgb[p+1]+0.0722*capture.linearRgb[p+2];mean+=luma;peak=Math.max(peak,luma);count++;
        }
        convergence.push({iterations:target,emittedPhotons:capture.emittedPhotons,roiMeanLuminance:mean/count,roiPeakLuminance:peak,elapsedMs:performance.now()-started});
      }
    }
    const { linearRgb, linearXyz, sampleCounts, ...metadata } = capture;
    return { pixels: Array.from(linearRgb), xyzPixels: linearXyz ? Array.from(linearXyz) : undefined, convergence, metadata: { ...metadata, scene: spectral ? 'cornell-nbk7-sphere' : glass ? 'cornell-glass-sphere' : 'cornell-diffuse-sphere', stage, referenceKind: 'GPU regression capture', adapter: lastStats.adapter, managedBytes: lastStats.bytes, elapsedMs: performance.now() - started } };
  }, { glass, spectral, sppm, stage });
  const directory = new URL('../docs/validation/', import.meta.url); await mkdir(directory, { recursive: true });
  await page.locator('#control-canvas').screenshot({ path: fileURLToPath(new URL(`stage${stage}-cornell.png`, directory)) });
  const { width, height } = result.metadata;
  const writePfm = async (values, filename) => {
    const pixels = Buffer.alloc(width * height * 12);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) pixels.writeFloatLE(values[((height - 1 - y) * width + x) * 3 + channel], (y * width + x) * 12 + channel * 4);
    await writeFile(new URL(filename, directory), Buffer.concat([Buffer.from(`PF\n${width} ${height}\n-1.0\n`), pixels]));
  };
  await writePfm(result.pixels, `stage${stage}-cornell.pfm`);
  if (result.xyzPixels) await writePfm(result.xyzPixels, `stage${stage}-cornell-xyz.pfm`);
  await writeFile(new URL(`stage${stage}-cornell.json`, directory), JSON.stringify(result.metadata, null, 2) + '\n');
  console.log(JSON.stringify(result.metadata));
  if(sppm) {
    await writeFile(new URL(`stage${stage}-convergence.json`,directory),JSON.stringify({roi:{x:[0.35,0.65],y:[0.8,0.95]},checkpoints:result.convergence},null,2)+'\n');
    const checks=await page.evaluate(async()=>{const {verifySppm}=await import('/src/debug/verify-sppm.ts');return verifySppm();});
    await writeFile(new URL(`stage${stage}-hash-checks.json`,directory),JSON.stringify(checks,null,2)+'\n');
    console.log(JSON.stringify(result.convergence));
  }
  if (spectral && !sppm) {
    const checks = await page.evaluate(async () => { const { verifySpectral } = await import('/src/debug/verify-spectral.ts'); return verifySpectral(); });
    await writeFile(new URL('stage5-spectral-checks.json', directory), JSON.stringify(checks, null, 2) + '\n');
  }
} finally { await browser?.close(); server.kill(); }
