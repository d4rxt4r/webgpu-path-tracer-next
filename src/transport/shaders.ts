import layouts from "./layouts.wgsl?raw";
import intersections from "./intersections.wgsl?raw";
import preciseIntersections from "./precise-intersections.wgsl?raw";
import debug from "./debug.wgsl?raw";
import sampler from "./sampler.wgsl?raw";
import lighting from "./lighting.wgsl?raw";
import textures from "./textures.wgsl?raw";
import tracer from "./path-tracer.wgsl?raw";
import media from "./media.wgsl?raw";
import dielectric from "./dielectric.wgsl?raw";
import spectrum from "./spectrum.wgsl?raw";
import color from "./color.wgsl?raw";
import output from "./path-output.wgsl?raw";
import diagnostics from "./diagnostics.wgsl?raw";
import display from "../render/display.wgsl?raw";
export const intersectionCore = layouts + "\n" + preciseIntersections + "\n" + intersections;
export const debugShader = intersectionCore + "\n" + debug;
export const pathCore =
  intersectionCore +
  "\n" +
  sampler +
  "\n" +
  spectrum +
  "\n" +
  textures +
  "\n" +
  lighting +
  "\n" +
  dielectric +
  "\n" +
  media +
  "\n" +
  tracer;
export const pathShader = pathCore + "\n" + color + "\n" + diagnostics + "\n" + output;
export const displayShader = layouts + "\n" + color + "\n" + display;
