import { unpackBvh } from './unpack';
import { traverseBvh } from './intersect';
import { cameraBasis, cameraOptics } from '../scene/camera';
import type { PreparedScene } from '../assets/prepare';
import type { CameraDescription, Vec3 } from '../scene/types';
import { definitions } from './pack';
const materialStride=definitions.structs.Material!.size/4, kindOffset=definitions.structs.Material!.fields.kind!.offset/4;
const validated = new WeakMap<CameraDescription, {packed: PreparedScene; key: string}>();
const cache = new WeakMap<PreparedScene, ReturnType<typeof unpackBvh>>();
function geometry(packed: PreparedScene) { let bvh = cache.get(packed); if (!bvh) { bvh=unpackBvh(packed); cache.set(packed,bvh); } return bvh; }
export function pickCameraPoint(packed: PreparedScene, camera: CameraDescription, x: number, y: number, width: number, height: number): Vec3 | undefined {
  if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) return;
  const b = cameraBasis(camera);
  const d = b.forward.map((v,i)=>v+(2*(Math.floor(x)+.5)/width-1)*width/height*b.right[i]!+(1-2*(Math.floor(y)+.5)/height)*b.up[i]!) as Vec3;
  const length=Math.hypot(...d), direction=d.map(v=>v/length) as Vec3;
  const hit=traverseBvh({origin:b.eye,direction,tMin:.00001,tMax:Infinity},geometry(packed));
  return hit ? b.eye.map((v,i)=>v+direction[i]!*hit.t) as Vec3 : undefined;
}
/** Intersect each volume boundary with the lens plane, then test the resulting segment against its bounding disk. */
export function validateAperture(packed: PreparedScene, camera: CameraDescription): void {
  const optics=cameraOptics(camera);
  const key=JSON.stringify([camera.position,camera.target,camera.up,optics.radius]);
  if(!optics.active || (validated.get(camera)?.packed === packed && validated.get(camera)?.key === key)) return;
  const {eye,forward}=cameraBasis(camera), radius=optics.radius;
  const dot=(a:number[],b:number[])=>a.reduce((s,v,i)=>s+v*b[i]!,0);
  const sub=(a:number[],b:number[])=>a.map((v,i)=>v-b[i]!);
  const segmentDistance=(a:number[],b:number[])=>{const d=sub(b,a), t=Math.max(0,Math.min(1,-dot(a,d)/(dot(d,d)||1)));return Math.hypot(...a.map((v,i)=>v+t*d[i]!));};
  const materialWords=new Uint32Array(packed.materials);
  const bvh = geometry(packed), stack = [0];
  while (stack.length) {
    const node = bvh.nodes[stack.pop()!]!;
    // The disk is contained in this cube; BVH culling keeps orbit validation
    // local even for large models and cameras far from every boundary.
    if (node.min.some((v,i)=>v > eye[i]! + radius + 1e-8) ||
        node.max.some((v,i)=>v < eye[i]! - radius - 1e-8)) continue;
    if (!node.count) { stack.push(node.first, node.first + 1); continue; }
    for (let index = node.first; index < node.first + node.count; index++) {
      const triangle = bvh.triangles[index]!;
      // Material.kind=2 is volumetric glass; thin interfaces use a different kind.
      if(materialWords[triangle.material!*materialStride+kindOffset]!==2) continue;
      const vertices=[triangle.a,triangle.b,triangle.c].map(v=>sub(v,eye));
      const distances=vertices.map(v=>dot(v,forward));
      if(Math.min(...distances)>1e-8 || Math.max(...distances)<-1e-8) continue;
      const points:number[][]=[];
      for(let i=0;i<3;i++) {
        const a=vertices[i]!, b=vertices[(i+1)%3]!, da=distances[i]!, db=distances[(i+1)%3]!;
        if(Math.abs(da)<=1e-8) points.push(a);
        if(da*db<0) points.push(a.map((v,j)=>v+(b[j]!-v)*da/(da-db)));
      }
      let intersects=points.some(v=>Math.hypot(...v)<=radius+1e-8);
      for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) intersects ||= segmentDistance(points[i]!,points[j]!)<=radius+1e-8;
      if(distances.every(d=>Math.abs(d)<=1e-8)) {
        const a=vertices[0]!, e=sub(vertices[1]!,a), f=sub(vertices[2]!,a), det=dot(e,e)*dot(f,f)-dot(e,f)**2;
        const u=(-dot(a,e)*dot(f,f)+dot(a,f)*dot(e,f))/det, v=(-dot(a,f)*dot(e,e)+dot(a,e)*dot(e,f))/det;
        intersects ||= u>=0&&v>=0&&u+v<=1;
      }
      if(intersects) throw new Error('Диск диафрагмы пересекает границу объёмного стекла. Уменьшите диаметр или переместите камеру.');
    }
  }
  validated.set(camera, {packed,key});
}
