import { rgbPathShader } from '../src/transport/pt-source.ts';
import { fastTransportShader } from '../src/transport/fast-source.ts';
import { checkedShader } from '../src/gpu/device.ts';
import { GpuScene } from '../src/gpu/scene.ts';

function traversal(source, width) {
  source=source.replaceAll('\r\n','\n');
  const start=source.indexOf('      if (node.first >= arrayLength(&nodes) - 1u)');
  const end=source.indexOf('\n    }\n  }',start);
  if(start<0||end<start) throw Error('Wide BVH marker mismatch');
  return source.slice(0,start)+`
      if(node.first>=arrayLength(&nodes)-${width-1}u){return failHit(ray,1u,visits);}
      var distances:array<f32,${width}>;var children:array<u32,${width}>;var count=0u;
      for(var child=0u;child<${width}u;child++) {
        let index=node.first+child;if(nodes[index].count==NO_HIT){continue;}
        let near=boundsNearPrepared(ray,nodes[index],limit,reciprocal);if(near==FAR){continue;}
        var position=count;
        while(position>0u){if(distances[position-1u]<=near){break;}distances[position]=distances[position-1u];children[position]=children[position-1u];position--;}
        distances[position]=near;children[position]=index;count++;
      }
      if(size+count>STACK_SIZE){return failHit(ray,2u,visits);}
      for(var child=count;child>0u;child--){stack[size]=children[child-1u];size++;}
`+source.slice(end);
}
function wideNodes(data,width) {
  const words=new Uint32Array(data),floats=new Float32Array(data),output=[];
  const blank=()=>{const node=new Uint32Array(8);node[7]=0xffffffff;return node;};
  const area=index=>{const p=index*8,x=floats[p+4]-floats[p],y=floats[p+5]-floats[p+1],z=floats[p+6]-floats[p+2];return 2*(x*y+x*z+y*z);};
  const build=(source,target)=>{
    output[target]=words.slice(source*8,source*8+8);
    if(words[source*8+7]>0) return;
    const first=words[source*8+3],frontier=[first,first+1];
    while(frontier.length<width){
      let choice=-1,best=-1;
      frontier.forEach((index,i)=>{if(words[index*8+7]===0&&area(index)>best){choice=i;best=area(index);}});
      if(choice<0) break;
      const child=words[frontier[choice]*8+3];frontier.splice(choice,1,child,child+1);
    }
    const destination=output.length;output[target][3]=destination;
    for(let i=0;i<width;i++) output.push(blank());
    frontier.forEach((child,i)=>build(child,destination+i));
  };
  output.push(blank());build(0,0);
  const packed=new Uint32Array(output.length*8);output.forEach((node,i)=>packed.set(node,i*8));return packed.buffer;
}

/** Full precision and ordinary traversal share the same lossless wide nodes. */
export async function wideCandidate(session,width) {
  if(width!==4&&width!==8) throw Error('Unsupported BVH width');
  const renderer=session.renderer,device=renderer.device;
  renderer.pause();await renderer.activeFrame;
  const baseline={scene:renderer.scene,packed:renderer.packed,variants:new Map(renderer.pathVariants),pipeline:renderer.pathPipeline,repair:renderer.pathRepairPipeline};
  const nodes=wideNodes(baseline.packed.nodes,width),packed={...baseline.packed,nodes,nodeCount:nodes.byteLength/32};
  const at=performance.now();
  const source=traversal(rgbPathShader(),width);
  const common=fastTransportShader(source,false).replace(/  let translated=max\(abs\(a\),max\(abs\(b\),abs\(c\)\)\);\n  let coordinateError=5\.364421e-7[^\n]*;/,'  var coordinateError=shear.coordinateError;');
  const [precise,fast]=await Promise.all([checkedShader(device,source,'Wide BVH precise'),checkedShader(device,common,'Wide BVH common')]);
  const [pipeline,repair]=await Promise.all([
    device.createComputePipelineAsync({layout:'auto',compute:{module:fast,entryPoint:'main'}}),
    device.createComputePipelineAsync({layout:'auto',compute:{module:precise,entryPoint:'repairMain'}})]);
  const compileMs=performance.now()-at,scene=new GpuScene(device,packed,renderer.environment);
  return {compileMs,nodeCount:packed.nodeCount,bytes:scene.bytes,
    apply(){renderer.scene=scene;renderer.packed=packed;renderer.pathPipeline=pipeline;renderer.pathRepairPipeline=repair;renderer.pathVariants.set('rgb',{pipeline,repair});renderer.updateGroups();},
    restore(){renderer.scene=baseline.scene;renderer.packed=baseline.packed;renderer.pathPipeline=baseline.pipeline;renderer.pathRepairPipeline=baseline.repair;renderer.pathVariants=new Map(baseline.variants);renderer.updateGroups();},
    dispose(){scene.dispose();}};
}
