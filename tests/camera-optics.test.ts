import { describe, expect, it } from 'vitest';
import { cameraOptics, sampleAperture, logDistance, distanceFraction, CAMERA_DISTANCE_MAX } from '../src/scene/camera';
import { pickCameraPoint, validateAperture } from '../src/accel/camera-optics';
import { cornellScene } from '../src/scene/cornell';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { packBvh } from '../src/accel/pack';
import { packTransport } from '../src/accel/materials';
import { exportPbrt } from '../src/debug/export-pbrt';
import type { CameraDescription } from '../src/scene/types';
import { shellScene } from '../src/debug/shell-fixture';
import { cameraShells } from '../src/accel/camera-media';

const camera = (): CameraDescription => ({position:[0,0,4],target:[0,0,0],up:[0,1,0],verticalFov:40});
describe('camera optics', () => {
  it('preserves pinhole defaults and validates disabled settings', () => {
    const c=camera(); expect(cameraOptics(c)).toMatchObject({active:false,radius:0,distance:4,blades:6,shape:'circle'});
    c.depthOfField={enabled:true,apertureDiameter:0}; expect(cameraOptics(c).active).toBe(false);
    c.depthOfField.apertureDiameter=.101; expect(()=>cameraOptics(c)).toThrow();
  });
  it('round trips logarithmic ranges including 12, 25 and 100 metres', () => {
    for(const value of [.25,12,25,CAMERA_DISTANCE_MAX]) expect(logDistance(distanceFraction(value,.25,100),.25,100)).toBeCloseTo(value,12);
    expect(logDistance(.5,.01,1000)).toBeCloseTo(Math.sqrt(10));
  });
  it('projects world points onto the moving focus plane and keeps manual distance fixed', () => {
    const c=camera(); c.depthOfField={focusMode:'point',focusPoint:[2,0,1]}; expect(cameraOptics(c).distance).toBeCloseTo(3);
    c.position=[0,0,6]; expect(cameraOptics(c).distance).toBeCloseTo(5);
    c.depthOfField.focusMode='manual'; c.depthOfField.focusDistance=2; expect(cameraOptics(c).distance).toBe(2);
    c.depthOfField.focusMode='point'; c.depthOfField.focusPoint=[0,0,7]; expect(cameraOptics(c)).toMatchObject({distance:.01,behind:true});
  });
  it('uniformly samples disk area and polygon triangle area', () => {
    for(const blades of [0,3,6,12]) {
      let x=0,y=0,r2=0;
      for(let i=0;i<10000;i++) { const p=sampleAperture((i+.5)/10000,((i*7919)%10000+.5)/10000,blades,37); x+=p[0]; y+=p[1]; r2+=p[0]**2+p[1]**2; expect(Math.hypot(...p)).toBeLessThanOrEqual(1); }
      expect(x/10000).toBeCloseTo(0,3); expect(y/10000).toBeCloseTo(0,3);
      expect(r2/10000).toBeCloseTo(blades ? (2+Math.cos(2*Math.PI/blades))/6 : .5,3);
    }
  });
  it('picks the first surface and rejects a disk crossing volumetric glass', () => {
    const scene=cornellScene('glass'), bvh=buildBvh(bakeTriangles(scene));
    const packed={...packBvh(bvh),...packTransport(scene,bvh)};
    const point=pickCameraPoint(packed,scene.camera,32,16,64,32); expect(point?.every(Number.isFinite)).toBe(true);
    expect(pickCameraPoint(packed,scene.camera,1e6,1e6,64,32)).toBeUndefined();
    const glass=bvh.triangles.find(t=>scene.materials[t.material!]?.type==='dielectric')!;
    const center=glass.a.map((v,i)=>(v+glass.b[i]!+glass.c[i]!)/3) as [number,number,number];
    const c={...camera(),position:center,target:[center[0],center[1],center[2]-1] as [number,number,number],depthOfField:{enabled:true,apertureDiameter:.02}};
    expect(()=>validateAperture(packed,c)).toThrow(/диафрагмы/);
    c.position=[0,0,4]; c.target=[0,0,0]; expect(()=>validateAperture(packed,c)).not.toThrow();
  });
  it('exports circular lens radius and rejects active polygonal apertures', () => {
    const scene=cornellScene(); scene.camera.depthOfField={enabled:true,apertureDiameter:.02};
    expect(exportPbrt(scene,32,32,4,'test.exr')).toContain('"float lensradius" [0.01]');
    scene.camera.depthOfField.apertureShape='polygon'; expect(()=>exportPbrt(scene,32,32,4,'test.exr')).toThrow(/polygonal/);
  });
  it('accepts a disk wholly inside glass and detects crossings away from its centre', () => {
    const scene=shellScene('reference',true), bvh=buildBvh(bakeTriangles(scene));
    const packed={...packBvh(bvh),...packTransport(scene,bvh)};
    scene.camera.depthOfField={enabled:true,apertureDiameter:.1};
    expect(()=>validateAperture(packed,scene.camera)).not.toThrow();
    expect(cameraShells(packed,scene.camera.position).length).toBe(1);
    // The centre is inside; the disk crosses the x=2 face in its own plane.
    scene.camera.position=[1.98,.13,1.5]; scene.camera.target=[1.98,.13,4];
    expect(()=>validateAperture(packed,scene.camera)).toThrow(/диафрагмы/);
    scene.camera.position=[2.1,.13,1.5]; scene.camera.target=[2.1,.13,4];
    expect(()=>validateAperture(packed,scene.camera)).not.toThrow();
    expect(cameraShells(packed,scene.camera.position).length).toBe(0);
  });
});
