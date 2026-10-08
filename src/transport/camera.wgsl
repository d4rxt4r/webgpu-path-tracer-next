// Reserved Sobol dimensions 510/511; bounce dimensions end below 510 at depth 64.
fn thinLensRay(camera: CameraParams, direction: vec3f, pixel: u32) -> Ray {
  if(camera.optics.x == 0.0) {return Ray(camera.eye.xyz,0.00001,direction,1e20);}
  let u=sample1D(camera.frame,510u,pixel,camera.seed);
  let v=sample1D(camera.frame,511u,pixel,camera.seed);
  let r=sqrt(v); let angle=6.28318530718*u+camera.optics.w;
  var aperture=r*vec2f(cos(angle),sin(angle));
  if(camera.optics.z>=3.0) {
    let sector=u*camera.optics.z; let a=floor(sector)*6.28318530718/camera.optics.z+camera.optics.w;
    let b=a+6.28318530718/camera.optics.z;
    aperture=r*mix(vec2f(cos(a),sin(a)),vec2f(cos(b),sin(b)),fract(sector));
  }
  let offset=camera.optics.x*(aperture.x*normalize(camera.right.xyz)+aperture.y*normalize(camera.up.xyz));
  let focus=direction*(camera.optics.y/dot(direction,camera.forward.xyz));
  return Ray(camera.eye.xyz+offset,0.00001,normalize(focus-offset),1e20);
}
