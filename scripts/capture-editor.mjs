import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const address='http://127.0.0.1:5319';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5319','--strictPort'],{stdio:'ignore',windowsHide:true});
const directory=new URL('../docs/validation/',import.meta.url);
let browser;
try {
  await mkdir(directory,{recursive:true});
  const started=Date.now();
  while(true){try{if((await fetch(address)).ok)break;}catch{/* Starting owned Vite. */}if(server.exitCode!==null||Date.now()-started>10000)throw new Error('Editor capture server did not start');await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({channel:'chrome'});const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(address);await expect(page.locator('#scene')).toBeEnabled({timeout:30000});
  await page.locator('#sample-limit').fill('64');await page.locator('#sample-limit').blur();
  await page.locator('#resolution').selectOption('76800');await page.locator('#batch').evaluate(el=>{el.closest('details').open=true;});await page.locator('#batch').selectOption('2048');
  await expect(page.locator('#status')).toHaveText('Пауза',{timeout:180000});
  await expect(page.locator('canvas')).toHaveAttribute('data-samples','64');await expect(page.locator('#error')).toBeHidden();
  const stats=await page.locator('#stats').textContent();
  console.log('Editor accumulation complete:',stats);
  await page.locator('#export-png').evaluate(el=>{el.closest('details').open=true;});
  const savePng=async(name)=>{const pending=page.waitForEvent('download');await page.locator('#export-png').click();await (await pending).saveAs(fileURLToPath(new URL(name,directory)));};
  const captureRaw=async()=>{
    const files=[];const handler=file=>files.push(file);page.on('download',handler);
    try{await page.locator('#export-pfm').click();await expect.poll(()=>files.length).toBe(2);return files;}finally{page.off('download',handler);}
  };
  await savePng('stage9-denoised.png');const initial=await captureRaw();
  const pfm=initial.find(file=>file.suggestedFilename().endsWith('.pfm')),json=initial.find(file=>file.suggestedFilename().endsWith('.json'));
  const pfmPath=fileURLToPath(new URL('stage9-editor.pfm',directory)),jsonPath=fileURLToPath(new URL('stage9-editor.json',directory));await pfm.saveAs(pfmPath);await json.saveAs(jsonPath);
  const bytes=await readFile(pfmPath),metadata=JSON.parse(await readFile(jsonPath,'utf8'));
  await page.locator('#denoiser').uncheck();await page.waitForTimeout(150);await savePng('stage9-raw.png');
  const unfiltered=await captureRaw(),rawPath=await unfiltered.find(file=>file.suggestedFilename().endsWith('.pfm')).path();
  const rawPreserved=bytes.equals(await readFile(rawPath));
  if(!rawPreserved||metadata.samples!==64||metadata.sampleCountRange.some(count=>count!==64)||errors.length)throw new Error('Editor capture acceptance failed');
  await page.locator('#denoiser').check();await page.waitForTimeout(150);
  await page.locator('details').evaluateAll(nodes=>nodes.forEach((node,index)=>{node.open=index===0||index===5;}));await page.locator('.inspector').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:fileURLToPath(new URL('stage9-editor.png',directory))});
  const result={scene:'Suzanne',iterations:64,emittedPhotons:metadata.emittedPhotons,rawPreserved,pfmSha256:createHash('sha256').update(bytes).digest('hex'),errors,stats,denoiser:metadata.display,elapsedMs:Date.now()-started,referenceKind:'Production UI capture; not an independent energy reference'};
  await writeFile(new URL('stage9-editor-checks.json',directory),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser?.close();server.kill();}
