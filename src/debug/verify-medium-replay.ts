import { renderSppm } from "./render-sppm";
import { slabSppmScene } from "../scene/sppm-control";
import { shellBox } from "./shell-fixture";
import type { CommonMediumCapacity } from "../transport/medium-source";
import { createDevice } from "../gpu/device";

export function layeredSppmScene(layers: number, inside = false) {
  const base = slabSppmScene(false);
  const glass = Array.from({length:layers}, (_,i) => shellBox([-10,0.25+i*0.001,-10],[10,0.5-i*0.001,10]));
  const scene = {...base, meshes: [base.meshes[0]!,...glass,base.meshes[2]!],
    objects: Array.from({length:layers+2}, (_,mesh) => ({mesh,material:mesh===0?0:mesh===layers+1?2:1,transform:base.objects[0]!.transform})),
    lights: [{object:layers+1}], camera: {...base.camera,
      position:[0.013,inside?0.375:0.1,0.017] as [number,number,number], target:[0.013,0,0.017] as [number,number,number]}};
  return scene;
}

/** Exceed compact state both during photon tracing and at the camera origin;
 * the full precise pass is the reference, including every photon slot.
 */
export async function verifyMediumReplay(progress?: (message:string)=>void) {
  const results = [];
  const gpu = await createDevice();
  try {
  for (const mode of ["rgb","spectral"] as const) {
    for (const [capacity,layers,inside] of [[2,2,false],[2,3,false],[4,4,false],[4,5,false],[8,9,false],[4,5,true],[4,32,true]] as const) {
      progress?.(`${mode} capacity=${capacity} layers=${layers} inside=${inside}`);
      const scene=layeredSppmScene(layers,inside);
      const options={gpu,width:8,height:8,iterations:4,maxDepth:8,seed:17,mode,photonsPerIteration:1024,photonBatchSize:512,initialRadius:0.15,specializeSampler:true};
      const reference=await renderSppm(scene,{...options,preciseTransport:true});
      const compact=await renderSppm(scene,{...options,mediumCapacity:capacity as CommonMediumCapacity});
      let squared=0,energy=0;
      for(let i=0;i<reference.pixels.length;i++) {squared+=(reference.pixels[i]!-compact.pixels[i]!)**2;energy+=reference.pixels[i]!**2;}
      results.push({mode,capacity,layers,inside,errors:reference.errors+compact.errors,
        countsComplete:compact.counts.every(n=>n===4),emittedPhotons:compact.emittedPhotons,
        nonFinite:compact.pixels.filter(n=>!Number.isFinite(n)).length,
        normalizedRmse:Math.sqrt(squared/Math.max(energy,1e-30)),energy});
    }
  }
  return results;
  } finally {gpu.device.destroy();}
}
