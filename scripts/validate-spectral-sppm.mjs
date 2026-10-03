import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'node:net';

const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const pbrt=argument('--pbrt');if(!pbrt)throw new Error('Provide --pbrt <path to PBRT v4 executable>');
const selected=argument('--case');if(selected&&!['prism','slab','cornell','constant'].includes(selected))throw new Error('Unknown reference case');
const directory=fileURLToPath(new URL('../docs/validation/',import.meta.url));await mkdir(directory,{recursive:true});
const run=(executable,args,options={})=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,...options});let stderr='';child.stderr?.on('data',chunk=>{stderr+=chunk;});child.on('error',reject);child.on('exit',code=>code===0?resolve(stderr):reject(new Error(`${executable} exited ${code}: ${stderr}`)));
});
function pfm(buffer) {
  let offset=0;const line=()=>{const end=buffer.indexOf(10,offset);const value=buffer.toString('ascii',offset,end).trim();offset=end+1;return value;};
  if(line()!=='PF')throw new Error('Expected RGB PFM');const [width,height]=line().split(/\s+/).map(Number),scale=Number(line());
  if(scale>=0)throw new Error('Expected little-endian PFM');const pixels=[];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++)pixels.push(buffer.readFloatLE(offset+((height-1-y)*width+x)*12+c*4)*Math.abs(scale));
  return {width,height,pixels};
}
async function writePfm(values,width,height,filename) {
  const data=Buffer.alloc(width*height*12);for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++)data.writeFloatLE(values[((height-1-y)*width+x)*3+c],(y*width+x)*12+c*4);
  await writeFile(`${directory}/${filename}`,Buffer.concat([Buffer.from(`PF\n${width} ${height}\n-1.0\n`),data]));
}
const xyzToRgb=([x,y,z])=>[3.2404542*x-1.5371385*y-0.4985314*z,-0.969266*x+1.8760108*y+0.041556*z,0.0556434*x-0.2040259*y+1.0572252*z];
const rgbToXyz=([r,g,b])=>[0.4124564*r+0.3575761*g+0.1804375*b,0.2126729*r+0.7151522*g+0.072175*b,0.0193339*r+0.119192*g+0.9503041*b];
function mean(pixels,width,height,roi,xyz=false) {
  let sum=0,count=0;for(let y=Math.floor(roi[2]*height);y<Math.floor(roi[3]*height);y++)for(let x=Math.floor(roi[0]*width);x<Math.floor(roi[1]*width);x++) {
    const pixel=pixels.slice((y*width+x)*3,(y*width+x)*3+3);sum+=xyz?pixel[1]:rgbToXyz(pixel)[1];count++;
  }return sum/count;
}
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const address=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore',windowsHide:true});let browser;
try {
  const start=Date.now();while(true){if(server.exitCode!==null||Date.now()-start>10000)throw new Error('Reference server failed');try{if((await fetch(address)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'chrome'});const page=await browser.newPage();await page.goto(address+'/?scene=control');await page.locator('#status').filter({hasText:'WebGPU готов'}).waitFor();await page.getByRole('button',{name:'Пауза',exact:true}).click();
  for(const name of selected?[selected]:['prism','slab','cornell','constant']) {
    if(name==='prism') {
      const checks=await page.evaluate(async()=>{const {verifySppmPrism}=await import('/src/debug/verify-sppm-prism.ts');return verifySppmPrism();});
      await writeFile(`${directory}/stage7-prism-checks.json`,JSON.stringify(checks,null,2)+'\n');console.log(JSON.stringify(checks));
      if(checks.errors||checks.maxPositionError>0.0005||checks.maxFluxRelativeError>0.001||checks.results[0].matchedPaths<100||checks.results[0].meanFootprintSpread<0.005||checks.results[1].meanFootprintSpread!==0)throw new Error('SPPM prism acceptance failed');
      continue;
    }
    const sceneData=await page.evaluate(async(name)=>{
      const {slabSppmScene}=await import('/src/scene/sppm-control.ts');const {cornellScene}=await import('/src/scene/cornell.ts');const {exportPbrt}=await import('/src/debug/export-pbrt.ts');const {slabSppmReference}=await import('/src/debug/sppm-reference.ts');
      const scene=name==='slab'?slabSppmScene():cornellScene(name==='constant'?'nbk7-constant':'nbk7');const width=name==='slab'?4:32,height=name==='slab'?4:24;
      const samples=name==='slab'?1048576:65536;
      return {source:exportPbrt(scene,width,height,samples,`stage7-${name}-pbrt-17.pfm`),width,height,samples,cpu:name==='slab'?slabSppmReference():undefined};
    },name);
    const prefix=`stage7-${name}`,filename=`${prefix}.pbrt`;await writeFile(`${directory}/${filename}`,sceneData.source);
    const references=[];
    for(const seed of [17,29]) {
      console.log(`PBRT ${name}: ${sceneData.samples} spp, seed ${seed}`);
      await run(pbrt,['--quiet','--nthreads','8','--seed',String(seed),'--outfile',`${prefix}-pbrt-${seed}.pfm`,filename],{cwd:directory,stdio:['ignore','ignore','pipe']});
      references.push(pfm(await readFile(`${directory}/${prefix}-pbrt-${seed}.pfm`)));
    }
    console.log(`GPU spectral SPPM ${name}`);
    const gpu=await page.evaluate(async(name)=>{
      const {renderSppm}=await import('/src/debug/render-sppm.ts');const {slabSppmScene}=await import('/src/scene/sppm-control.ts');const {cornellScene}=await import('/src/scene/cornell.ts');
      return renderSppm(name==='slab'?slabSppmScene():cornellScene(name==='constant'?'nbk7-constant':'nbk7'),{width:name==='slab'?4:32,height:name==='slab'?4:24,iterations:name==='slab'?4096:2048,photonsPerIteration:8192,photonBatchSize:4096,initialRadius:name==='slab'?0.15:0.1,maxDepth:32});
    },name);
    await writePfm(gpu.pixels,gpu.width,gpu.height,`${prefix}-sppm-xyz.pfm`);
    const rgb=[];for(let i=0;i<gpu.pixels.length;i+=3)rgb.push(...xyzToRgb(gpu.pixels.slice(i,i+3)));await writePfm(rgb,gpu.width,gpu.height,`${prefix}-sppm.pfm`);
    const roi=name==='slab'?[0,1,0,1]:[0.35,0.65,0.8,0.95];
    const referenceMeans=references.map(image=>mean(image.pixels,image.width,image.height,roi));
    const referenceMean=(referenceMeans[0]+referenceMeans[1])/2,gpuMean=mean(gpu.pixels,gpu.width,gpu.height,roi,true);
    let squared=0;for(let i=0;i<rgb.length;i++)squared+=(rgb[i]-(references[0].pixels[i]+references[1].pixels[i])/2)**2;
    const report={case:name,pbrtSource:'https://github.com/mmp/pbrt-v4',pbrtCommit:'b4ce9687e6c695f5582997c61b0c66cf064bdb4a',width:gpu.width,height:gpu.height,pbrtSamplesPerPixel:sceneData.samples,pbrtSeeds:[17,29],pbrtThreads:8,sppmIterations:name==='slab'?4096:2048,sppmSeed:17,photonsPerIteration:8192,photonBatchSize:4096,initialRadius:name==='slab'?0.15:0.1,maxDepth:32,emittedPhotons:gpu.emittedPhotons,roi,referenceMeans,referenceRelativeSpread:Math.abs(referenceMeans[0]-referenceMeans[1])/referenceMean,gpuMean,relativeEnergyError:Math.abs(gpuMean/referenceMean-1),linearRgbRmse:Math.sqrt(squared/rgb.length),cpuXyz:sceneData.cpu,gpuErrors:gpu.errors,adapter:gpu.adapter};
    await writeFile(`${directory}/${prefix}-comparison.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
    if(gpu.errors||report.referenceRelativeSpread>0.02||report.relativeEnergyError>0.05)throw new Error(`Spectral SPPM ${name} acceptance failed`);
  }
} finally {await browser?.close();server.kill();}
