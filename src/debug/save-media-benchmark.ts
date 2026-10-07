import { encodePfm } from "../app/export";
import type { benchmarkMedia, MediaVariant } from "./benchmark-media";

type Report = Awaited<ReturnType<typeof benchmarkMedia>>;
const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)]!;
const rgb = (values: Float32Array, spectral: boolean) => spectral ? Float32Array.from(values, (_,i) => {
  const p=i-i%3, x=values[p]!, y=values[p+1]!, z=values[p+2]!;
  return i%3===0 ? 3.2404542*x-1.5371385*y-0.4985314*z : i%3===1 ? -0.969266*x+1.8760108*y+0.041556*z : 0.0556434*x-0.2040259*y+1.0572252*z;
}) : values;

/** Local artifact sink only; no render or filter work is included in timings. */
export async function saveMediaBenchmark(name: string, report: Report, variants: MediaVariant[], artifactNames = [variants[0]!.name, "pointer4"]) {
  const post = async (file: string, body: BodyInit) => {
    const response = await fetch(`http://127.0.0.1:5361/${name}-${file}`, {method:"POST",body});
    if (!response.ok) throw new Error(`Artifact save failed: ${response.status}`);
  };
  const hashes: Record<string,unknown> = {...report.sourceHashes}, quality: Record<string,unknown> = {}, medians: Record<string,unknown> = {};
  const reference = report.captures[variants[0]!.name]!;
  for (const variant of variants) {
    const capture=report.captures[variant.name]!;
    const measured=report.rows.filter(r=>!r.warmup && r.name===variant.name);
    const rows=measured.length ? measured : report.rows.filter(r=>r.name===variant.name);
    medians[variant.name]={gpuMs:median(rows.map(r=>r.gpuMs!)),completionMs:median(rows.map(r=>r.elapsedMs)),
      phases:Object.fromEntries(["camera","photon","gather","update"].map(p=>[p,median(rows.map(r=>r.phases[p]!.gpuMs))])),
      bytes:rows[0]!.bytes,errors:report.rows.filter(r=>r.name===variant.name).map(r=>r.errors)};
    let squared=0,energy=0,maxAbsolute=0;
    for(let i=0;i<capture.xyz.length;i++) {const d=capture.xyz[i]!-reference.xyz[i]!;squared+=d*d;energy+=reference.xyz[i]!**2;maxAbsolute=Math.max(maxAbsolute,Math.abs(d));}
    let roiDifference=0,roiEnergy=0;
    // Fixed image-space floor region; retain it for every seed and variant.
    for(let y=Math.floor(report.height*0.7);y<Math.floor(report.height*0.95);y++)for(let x=Math.floor(report.width*0.25);x<Math.floor(report.width*0.75);x++)for(let c=0;c<3;c++){
      const i=(y*report.width+x)*3+c;roiDifference+=(capture.xyz[i]!-reference.xyz[i]!)**2;roiEnergy+=reference.xyz[i]!**2;
    }
    let filteredDifference=0,filteredEnergy=0;
    if(capture.filtered && reference.filtered)for(let i=0;i<capture.filtered.length;i++){
      filteredDifference+=(capture.filtered[i]!-reference.filtered[i]!)**2;filteredEnergy+=reference.filtered[i]!**2;
    }
    quality[variant.name]={normalizedRmse:Math.sqrt(squared/Math.max(energy,1e-30)),maxAbsolute,
      floorRoiRmse:Math.sqrt(roiDifference/Math.max(roiEnergy,1e-30)),
      filteredRmse:capture.filtered && reference.filtered ? Math.sqrt(filteredDifference/Math.max(filteredEnergy,1e-30)) : null,errors:capture.errors,
      countsComplete:capture.counts.every(n=>n===report.iterations),emittedPhotons:capture.emittedPhotons};
    if(variant.source && !hashes[variant.name]) hashes[variant.name]=Object.fromEntries(await Promise.all(Object.entries(variant.source).map(async([k,v])=>[k,
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))),n=>n.toString(16).padStart(2,"0")).join("")])));
    if (!artifactNames.includes(variant.name)) continue;
    for(const [kind,values] of [["raw",capture.xyz],["filtered",capture.filtered]] as const) {
      if(!values) continue;
      const linearRgb=rgb(values,report.mode==="spectral");
      await post(`${variant.name}-${kind}.pfm`,encodePfm({width:report.width,height:report.height,linearRgb}));
      const canvas=document.createElement("canvas");canvas.width=report.width;canvas.height=report.height;
      const context=canvas.getContext("2d")!, image=context.createImageData(report.width,report.height);
      for(let p=0;p<linearRgb.length/3;p++) {for(let c=0;c<3;c++) {const value=Math.max(0,linearRgb[p*3+c]!),mapped=value/(1+value);
        image.data[p*4+c]=255*(mapped<=0.0031308?12.92*mapped:1.055*mapped**(1/2.4)-0.055);}image.data[p*4+3]=255;}
      context.putImageData(image,0,0);await post(`${variant.name}-${kind}.png`,await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),"image/png")));
    }
  }
  const {captures:_,...metadata}=report;
  const result={...metadata,sourceHashes:hashes,medians,quality,pngTransform:
    `${report.mode === "spectral" ? "XYZ to linear sRGB, " : "Linear RGB, "}exposure 1, Reinhard, sRGB transfer; negative display values clamped only in PNG`};
  await post("report.json",JSON.stringify(result,null,2));return {medians,quality};
}
