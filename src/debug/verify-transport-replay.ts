import { IntersectionRenderer } from '../render/intersection-renderer';
import { checkedShader } from '../gpu/device';
import { pathShader } from '../transport/shaders';
import { cornellScene } from '../scene/cornell';
import { renderSppm } from './render-sppm';

/** Force every path through replay, including queue overflow and pause/resume. */
export async function verifyTransportReplay() {
  const create = GPUDevice.prototype.createShaderModule;
  let forcedModules = 0;
  const force = () => {
    GPUDevice.prototype.createShaderModule = function(descriptor: GPUShaderModuleDescriptor) {
      if(descriptor.label === 'PT common transport' || descriptor.label === 'SPPM common transport') {
        const code=descriptor.code.replace(/fn closestHit\(ray: Ray\) -> Hit \{[^\r\n]+}/,
          'fn closestHit(ray:Ray)->Hit {let hit=traceBvh(ray,false);if(params.seed==17u){return failHit(ray,5u,0u);}return hit;}');
        if(code === descriptor.code) throw Error('Replay injection did not match');
        forcedModules++;
        return create.call(this,{...descriptor,code});
      }
      return create.call(this,descriptor);
    };
  };
  const pt = async (replay: boolean) => {
    const canvas=document.createElement('canvas');
    canvas.style.cssText='position:fixed;left:0;top:0;width:400px;height:200px;visibility:hidden';
    document.body.append(canvas);
    let partialDone!:()=>void,done!:()=>void,fail!:(e:Error)=>void;
    const partial=new Promise<void>(resolve=>partialDone=resolve);
    const completed=new Promise<void>((resolve,reject)=>{done=resolve;fail=reject;});
    void completed.catch(()=>{});
    let partialStopped=false,stopped=false;
    const renderer=new IntersectionRenderer(canvas,stats=>{
      if(replay && !partialStopped && stats.samples===0 && stats.tile>0) {
        partialStopped=true;renderer.pause();partialDone();
      }
      if(!stopped && stats.samples===1) {stopped=true;renderer.pause();done();}
    },fail);
    renderer.pause();renderer.setDebugView('beauty');
    renderer.setSettings({integrator:'pt',mode:'rgb',maxPixels:80000,maxDepth:8,seed:17});
    const state=renderer as unknown as {device:GPUDevice,pathPipeline:GPUComputePipeline,pathWorkgroup:[number,number],pathTileSize:number,updateGroups():void};
    state.pathTileSize=128;
    try {
      await renderer.setScene(cornellScene());await renderer.initialize();
      if(!replay) {
        const module=await checkedShader(state.device,pathShader,'PT replay reference');
        state.pathPipeline=await state.device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main',constants:{PT_WORKGROUP_X:state.pathWorkgroup[0],PT_WORKGROUP_Y:state.pathWorkgroup[1]}}});
        state.updateGroups();
      }
      renderer.resume();
      let partialCounts=true;
      if(replay) {
        await Promise.race([partial,completed]);
        const pending=await renderer.capture();
        partialCounts=pending.sampleCounts.every(n=>n===0) && pending.linearRgb.every(n=>n===0);
        renderer.resume();
      }
      await completed;
      const image=await renderer.capture();
      return {pixels:image.linearRgb,counts:image.sampleCounts,partialCounts};
    } finally {renderer.dispose();canvas.remove();}
  };
  const compare=(a:ArrayLike<number>,b:ArrayLike<number>)=>{
    let squared=0,energy=0,nonFinite=0;
    for(let i=0;i<a.length;i++){const x=a[i]!,y=b[i]!;squared+=(x-y)**2;energy+=x*x;if(!Number.isFinite(x)||!Number.isFinite(y))nonFinite++;}
    return {normalizedRmse:Math.sqrt(squared/Math.max(energy,1e-30)),nonFinite,energy};
  };
  try {
    const referencePt=await pt(false);
    force();const replayPt=await pt(true);
    GPUDevice.prototype.createShaderModule=create;
    const options={width:400,height:200,mode:'rgb' as const,iterations:1,maxDepth:8,seed:17,photonsPerIteration:512,photonBatchSize:128,initialRadius:0.15,specializeSampler:true};
    const referenceSppm=await renderSppm(cornellScene(),{...options,preciseTransport:true});
    force();const replaySppm=await renderSppm(cornellScene(),options);
    return {forcedModules,pt:{...compare(referencePt.pixels,replayPt.pixels),countsComplete:replayPt.counts.every(n=>n===1),partialCounts:replayPt.partialCounts},
      sppm:{...compare(referenceSppm.pixels,replaySppm.pixels),countsComplete:replaySppm.counts.every(n=>n===1),errors:replaySppm.errors,emittedPhotons:replaySppm.emittedPhotons}};
  } finally {GPUDevice.prototype.createShaderModule=create;}
}
