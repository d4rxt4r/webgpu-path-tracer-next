import layouts from './layouts.wgsl?raw';
import intersections from './intersections.wgsl?raw';
import debug from './debug.wgsl?raw';
export const intersectionCore = layouts + '\n' + intersections;
export const debugShader = intersectionCore + '\n' + debug;
