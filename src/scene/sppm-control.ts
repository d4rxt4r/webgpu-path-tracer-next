import type { MeshData, SceneDescription, SpectrumTable, Vec3 } from './types';
import { d65Spectrum, nbk7Ior } from '../transport/spectrum';

const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function plane(y:number,extent:number,up:boolean):MeshData {
  return {positions:new Float32Array([-extent,y,extent,extent,y,extent,extent,y,-extent,-extent,y,-extent]),indices:new Uint32Array(up?[0,1,2,0,2,3]:[0,2,1,0,3,2])};
}
export function spectralEmitterScene(spectrum:SpectrumTable=d65Spectrum):SceneDescription {
  return {version:1,meshes:[plane(0,2,true)],objects:[{mesh:0,material:0,transform:identity}],materials:[{type:'emissive',emission:[1,1,1],spectrum}],lights:[{object:0}],camera:{position:[0,0.1,0],target:[0,0,0],up:[0,0,1],verticalFov:0.1}};
}
/** Upward emitter has no direct contribution to the floor: all light is indirect. */
export function indirectSppmScene():SceneDescription {
  return {version:1,meshes:[plane(0,100,true),plane(1,100,false),plane(0.5,0.01,true)],objects:[0,1,2].map(mesh=>({mesh,material:mesh,transform:identity})),materials:[{type:'diffuse',reflectance:[0.001,0.001,0.001]},{type:'diffuse',reflectance:[0.5,0.5,0.5]},{type:'emissive',emission:[1,1,1],spectrum:d65Spectrum}],lights:[{object:2}],camera:{position:[0,0.1,0],target:[0,0,0],up:[0,0,1],verticalFov:0.1}};
}
/** Finite closed slab, all camera NEE to the emitter is occluded by glass. */
export function slabSppmScene(dispersive=true):SceneDescription {
  const low=0.25,high=0.5,e=10;
  const corners:Vec3[]=[[-e,low,-e],[e,low,-e],[e,low,e],[-e,low,e],[-e,high,-e],[e,high,-e],[e,high,e],[-e,high,e]];
  const slab:MeshData={positions:new Float32Array(corners.flat()),indices:new Uint32Array([0,1,2,0,2,3,4,6,5,4,7,6,0,4,5,0,5,1,1,5,6,1,6,2,2,6,7,2,7,3,3,7,4,3,4,0])};
  return {version:1,meshes:[plane(0,10,true),slab,plane(1,0.5,false)],objects:[0,1,2].map(mesh=>({mesh,material:mesh,transform:identity})),materials:[{type:'diffuse',reflectance:[0.001,0.001,0.001]},{type:'dielectric',ior:nbk7Ior(587.6),iorModel:dispersive?'nbk7':'constant',absorption:[0,0,0]},{type:'emissive',emission:[1,1,1],spectrum:d65Spectrum}],lights:[{object:2}],camera:{position:[0,0.1,0],target:[0,0,0],up:[0,0,1],verticalFov:0.1}};
}
