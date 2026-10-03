import layouts from './sppm-layouts.wgsl?raw';
import implementation from './sppm.wgsl?raw';
import { pathCore } from './shaders';
import { makeShaderDataDefinitions } from 'webgpu-utils';
export const sppmShader = pathCore+'\n'+layouts+'\n'+implementation;
export const sppmDefinitions = makeShaderDataDefinitions(layouts);
