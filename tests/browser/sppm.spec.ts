import { expect,test } from '@playwright/test';

test('GPU photon hash handles collisions and progressive updates match brute force',async({page})=>{
  await page.goto('/?scene=control');await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result=await page.evaluate(async()=>{const url='/src/debug/verify-sppm.ts';const {verifySppm}=await import(/* @vite-ignore */url);return verifySppm();});
  console.log('SPPM hash acceptance:',JSON.stringify(result));
  expect(result.counts).toEqual([3,3,1,0]);expect(result.errors).toBe(0);expect(result.maxError).toBeLessThan(2e-6);expect(result.invalidLinks).toBe(3);
});

for(const mode of ['rgb','spectral'] as const) test(`${mode} photon batches preserve energy and interrupted iterations reset cleanly`,async({page})=>{
  test.setTimeout(60000);
  await page.goto('/?scene=control');await expect(page.locator('#status')).toHaveText('WebGPU готов');await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result=await page.evaluate(async(mode)=>{
    const rendererUrl='/src/render/intersection-renderer.ts',sceneUrl='/src/scene/cornell.ts';
    const {IntersectionRenderer}=await import(/* @vite-ignore */rendererUrl);const {cornellScene}=await import(/* @vite-ignore */sceneUrl);
    const canvas=document.createElement('canvas');canvas.style.cssText='width:32px;height:32px';document.body.append(canvas);
    const errors:string[]=[];let samples=0,phase='',target=4,stopped=false;
    const renderer=new IntersectionRenderer(canvas,(stats:{samples:number;phase:string})=>{samples=stats.samples;phase=stats.phase;if(samples===target&&!stopped){stopped=true;renderer.pause();}},(error:Error)=>errors.push(error.message));
    const wait=async(condition:()=>boolean)=>{const start=performance.now();while(!condition()&&!errors.length&&performance.now()-start<20000)await new Promise(r=>setTimeout(r,10));if(!condition())throw new Error('SPPM stalled '+JSON.stringify({samples,phase,errors}));};
    try {
      const scene=cornellScene('glass');renderer.setDebugView('beauty');renderer.setSettings({integrator:'sppm',mode,maxPixels:1024,maxDepth:8,seed:17,photonsPerIteration:2048,photonBatchSize:256,initialRadius:0.15});
      await renderer.setScene(scene);await renderer.initialize();await wait(()=>stopped);const first=await renderer.capture();
      renderer.setExposure(1);await new Promise(r=>setTimeout(r,50));const exposed=await renderer.capture();const exposurePreserved=first.linearRgb.every((v:number,i:number)=>v===exposed.linearRgb[i]);
      renderer.setSettings({photonBatchSize:512});stopped=false;renderer.resume();await wait(()=>stopped);const second=await renderer.capture();
      let difference=0,energy=0;for(let i=0;i<first.linearRgb.length;i++){difference+=Math.abs(first.linearRgb[i]-second.linearRgb[i]);energy+=Math.abs(first.linearRgb[i]);}
      target=100;stopped=false;renderer.resume();await wait(()=>phase==='gather');renderer.pause();const partial=await renderer.capture();const partialPreserved=partial.samples===4&&partial.linearRgb.every((v:number,i:number)=>v===second.linearRgb[i]);renderer.setCamera(scene.camera);const reset=samples===0;
      target=1;stopped=false;await wait(()=>stopped);const restarted=await renderer.capture();
      return {errors,relativeDifference:difference/energy,energy,accumulationSpace:first.accumulationSpace,hasXyz:!!first.linearXyz,negativeRgb:first.linearRgb.some((v:number)=>v<0),exposurePreserved,partialPreserved,uniformCounts:first.sampleCounts.every((v:number)=>v===4),photons:first.emittedPhotons,reset,restartedSamples:restarted.samples,restartedCounts:restarted.sampleCounts.every((v:number)=>v===1),restartedPhotons:restarted.emittedPhotons};
    } finally {renderer.dispose();canvas.remove();}
  },mode);
  console.log('SPPM batch acceptance:',JSON.stringify(result));
  expect(result.errors).toEqual([]);expect(result.relativeDifference).toBeLessThan(1e-5);expect(result.energy).toBeGreaterThan(0);expect(result.exposurePreserved).toBe(true);expect(result.partialPreserved).toBe(true);expect(result.uniformCounts).toBe(true);expect(result.photons).toBe(8192);expect(result.reset).toBe(true);expect(result.restartedSamples).toBe(1);expect(result.restartedCounts).toBe(true);expect(result.restartedPhotons).toBe(2048);
  expect(result.accumulationSpace).toBe(mode==='spectral'?'cie-xyz':'linear-srgb');expect(result.hasXyz).toBe(mode==='spectral');if(mode==='spectral')expect(result.negativeRgb).toBe(true);
});

test('UI switches RGB SPPM and spectral PT without GPU errors',async({page})=>{
  test.setTimeout(60000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/?scene=control');await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.locator('#resolution').selectOption('19200');await page.locator('#material').selectOption('glass');await page.locator('#integrator').selectOption('sppm');
  await expect(page.locator('#mode')).toHaveValue('rgb');await expect(page.locator('#strategy')).toBeDisabled();
  await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-samples')),{timeout:30000}).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#stats')).toContainText('фотонов');await page.getByRole('button',{name:'Пауза',exact:true}).click();
  await page.locator('#mode').selectOption('spectral');await expect(page.locator('#integrator')).toHaveValue('sppm');await expect(page.locator('#strategy')).toBeDisabled();
  await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-samples')),{timeout:15000}).toBeGreaterThanOrEqual(1);
  await page.locator('#integrator').selectOption('pt');await expect(page.locator('#strategy')).toBeEnabled();
  await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-samples')),{timeout:15000}).toBe(1);
  await expect(page.locator('#error')).toBeHidden();expect(errors).toEqual([]);
});

test('SPPM direct light matches quadrature without counting first photon hits twice',async({page})=>{
  test.setTimeout(60000);await page.goto('/?scene=control');await expect(page.locator('#status')).toHaveText('WebGPU готов');await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result=await page.evaluate(async()=>{
    const url='/src/render/intersection-renderer.ts';const {IntersectionRenderer}=await import(/* @vite-ignore */url);
    const transform=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const scene={version:1,camera:{position:[0,0.5,0],target:[0,0,0],up:[0,0,1],verticalFov:0.1},meshes:[{positions:new Float32Array([-2,0,2,2,0,2,2,0,-2,-2,0,-2]),indices:new Uint32Array([0,1,2,0,2,3])},{positions:new Float32Array([-1,1,-1,1,1,-1,1,1,1,-1,1,1]),indices:new Uint32Array([0,1,2,0,2,3])}],objects:[{mesh:0,material:0,transform},{mesh:1,material:1,transform}],materials:[{type:'diffuse',reflectance:[0.5,0.5,0.5]},{type:'emissive',emission:[1,1,1]}],lights:[{object:1}]};
    const canvas=document.createElement('canvas');canvas.style.cssText='width:32px;height:32px';document.body.append(canvas);
    const errors:string[]=[];let stopped=false;
    const renderer=new IntersectionRenderer(canvas,(stats:{samples:number})=>{if(stats.samples===16&&!stopped){stopped=true;renderer.pause();}},(error:Error)=>errors.push(error.message));
    try {
      renderer.setDebugView('beauty');renderer.setSettings({integrator:'sppm',maxPixels:1024,maxDepth:4,photonsPerIteration:2048,photonBatchSize:256,initialRadius:0.2});await renderer.setScene(scene);await renderer.initialize();
      const start=performance.now();while(!stopped&&!errors.length&&performance.now()-start<30000)await new Promise(r=>setTimeout(r,10));if(!stopped)throw new Error('Direct SPPM stalled '+errors.join());
      const capture=await renderer.capture();let irradiance=0;for(let y=0;y<512;y++)for(let x=0;x<512;x++){const px=-1+(x+0.5)/256,pz=-1+(y+0.5)/256;irradiance+=4/(512*512)/(1+px*px+pz*pz)**2;}
      return {errors,mean:capture.linearRgb.reduce((sum:number,v:number)=>sum+v,0)/capture.linearRgb.length,reference:0.5*irradiance/Math.PI,photons:capture.emittedPhotons};
    }finally{renderer.dispose();canvas.remove();}
  });
  console.log('SPPM direct acceptance:',JSON.stringify(result));expect(result.errors).toEqual([]);expect(Math.abs(result.mean/result.reference-1)).toBeLessThan(0.02);expect(result.photons).toBe(32768);
});
