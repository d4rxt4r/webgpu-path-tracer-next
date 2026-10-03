import metadata from './suzanne-meta.json';
import type { MeshData } from '../scene/types';

export function parseSuzanne(data:ArrayBuffer):MeshData {
  if(data.byteLength!==metadata.byteLength||new TextDecoder().decode(new Uint8Array(data,0,8))!=='SGMESH01')throw new Error('Invalid Suzanne mesh header');
  const header=new DataView(data),vertices=header.getUint32(8,true),triangles=header.getUint32(12,true);
  const positionsOffset=header.getUint32(16,true),normalsOffset=header.getUint32(20,true),indicesOffset=header.getUint32(24,true);
  if(vertices!==metadata.finalStatistics.vertices||triangles!==metadata.triangles||positionsOffset!==32||normalsOffset!==32+vertices*12||indicesOffset!==32+vertices*24||indicesOffset+triangles*12!==data.byteLength||header.getUint32(28,true)!==0)throw new Error('Invalid Suzanne mesh layout');
  const positions=new Float32Array(data,positionsOffset,vertices*3),normals=new Float32Array(data,normalsOffset,vertices*3),indices=new Uint32Array(data,indicesOffset,triangles*3);
  if(!positions.every(Number.isFinite)||!normals.every(Number.isFinite)||indices.some(index=>index>=vertices))throw new Error('Invalid Suzanne mesh values');
  for(let i=0;i<vertices;i++)if(Math.abs(Math.hypot(normals[3*i]!,normals[3*i+1]!,normals[3*i+2]!)-1)>1e-5)throw new Error('Invalid Suzanne mesh normal');
  return {positions,normals,indices};
}
let pending:Promise<MeshData>|undefined;
/** Keep one CPU mesh for scene switches; GPU allocations are owned by the renderer. */
export function loadSuzanne():Promise<MeshData> {
  if(!pending)pending=(async()=>{
    const response=await fetch(`${import.meta.env.BASE_URL}assets/suzanne.bin`);
    if(!response.ok)throw new Error(`Suzanne resource: HTTP ${response.status}`);
    const data=await response.arrayBuffer();
    const digest=await crypto.subtle.digest('SHA-256',data);
    const sha256=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
    if(sha256!==metadata.sha256)throw new Error('Suzanne mesh checksum mismatch');
    return parseSuzanne(data);
  })().catch(error=>{pending=undefined;throw error;});
  return pending;
}
