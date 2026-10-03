import type { SceneDescription } from './types';
import { nbk7Absorption, nbk7Ior } from '../transport/spectrum';

/** Closed 60-degree control prism, extruded along Z, in meters. */
export function prismScene(): SceneDescription {
  return {
    version: 1, camera: { position: [-1,0.2,0], target: [0,0.376327,0], up: [0,0,1], verticalFov: 10 },
    meshes: [{ positions: new Float32Array([-0.5,0,-0.5,0.5,0,-0.5,0,Math.sqrt(0.75),-0.5,-0.5,0,0.5,0.5,0,0.5,0,Math.sqrt(0.75),0.5]), indices: new Uint32Array([0,2,1,3,4,5,0,1,4,0,4,3,1,2,5,1,5,4,2,0,3,2,3,5]) }],
    objects: [{ mesh: 0, material: 0, transform: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] }],
    materials: [{ type: 'dielectric', ior: nbk7Ior(587.6), iorModel: 'nbk7', absorption: [0.2,0.2,0.3], absorptionSpectrum: nbk7Absorption }], lights: [],
  };
}
