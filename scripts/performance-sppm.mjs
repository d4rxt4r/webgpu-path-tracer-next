import { sppmShader, specializedSppmShader } from '../src/transport/sppm-shader.ts';
import { checkedShader } from '../src/gpu/device.ts';

export function hoistGatherWear(source) {
  const start=source.indexOf('@compute @workgroup_size(8,8) fn gatherMain');
  const end=source.indexOf('@compute @workgroup_size(8,8) fn updateMain',start);
  if(start<0||end<start) throw Error('Gather marker mismatch');
  const original=source.slice(start,end);
  const gather=original.replace('  var phi=vec3f(0);var count=0u;',
    '  var pointMaterial:Material;var wavelength=0.0;\n  if(point.bsdf!=0u){pointMaterial=wornMaterial(materials[point.material],point.position,point.normal);wavelength=iterationWavelength().wavelength;}\n  var phi=vec3f(0);var count=0u;')
    .replace('roughDielectricEval(wornMaterial(materials[point.material],point.position,point.normal),point.wo,photon.incoming,point.normal,point.shading,point.eta,iterationWavelength().wavelength,false)',
      'roughDielectricEval(pointMaterial,point.wo,photon.incoming,point.normal,point.shading,point.eta,wavelength,false)');
  if(gather===original||gather.includes('roughDielectricEval(wornMaterial(')) throw Error('Gather wear marker mismatch');
  return source.slice(0,start)+gather+source.slice(end);
}
export async function gatherCandidate(renderer) {
  const base=renderer.sppm,original=base.pipelines.gather,at=performance.now();
  const source=renderer.specializedSppmSampler ? specializedSppmShader : sppmShader;
  const module=await checkedShader(renderer.device,hoistGatherWear(source),'Gather wear hoist');
  const pipeline=await renderer.device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'gatherMain'}});
  return {compileMs:performance.now()-at,
    apply(){base.pipelines.gather=pipeline;renderer.updateGroups();},
    restore(){base.pipelines.gather=original;renderer.updateGroups();}};
}
