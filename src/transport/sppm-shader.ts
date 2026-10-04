import layouts from "./sppm-layouts.wgsl?raw";
import implementation from "./sppm.wgsl?raw";
import diagnostics from "./diagnostics.wgsl?raw";
import { pathCore } from "./shaders";
import { makeShaderDataDefinitions } from "webgpu-utils";
import { referenceSamplerSource, sppmSamplerSource } from "./sampler-source";
export const sppmShader = pathCore + "\n" + layouts + "\n" + diagnostics + "\n" + implementation;
export const specializedSppmShader =
  pathCore.replace(referenceSamplerSource, sppmSamplerSource) +
  "\n" +
  layouts +
  "\n" +
  diagnostics +
  "\n" +
  implementation;
export const sppmDefinitions = makeShaderDataDefinitions(layouts);
