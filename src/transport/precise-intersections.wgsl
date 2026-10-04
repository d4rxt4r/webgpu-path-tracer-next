override PRECISE_TRANSPORT: bool = true;
// Double-single arithmetic for ambiguous edge hits only. Splitting by bits
// avoids relying on fma being fused (WGSL allows a non-fused implementation).
fn dsSum(a:f32,b:f32)->vec2f {
  let s=a+b;let v=s-a;
  return vec2f(s,(a-(s-v))+(b-v));
}
fn dsAdd(a:vec2f,b:vec2f)->vec2f {
  let s=dsSum(a.x,b.x);return dsSum(s.x,s.y+a.y+b.y);
}
fn dsSub(a:vec2f,b:vec2f)->vec2f {return dsAdd(a,-b);}
fn dsMul(a:vec2f,b:vec2f)->vec2f {
  let ah=bitcast<f32>(bitcast<u32>(a.x)&0xfffff000u);let al=a.x-ah;
  let bh=bitcast<f32>(bitcast<u32>(b.x)&0xfffff000u);let bl=b.x-bh;
  // The integer mask forces a rounded product before the error transform.
  // Without this barrier the driver can contract inlined expressions and
  // corrupt the low component. The removed bit is recovered by the residual.
  let p=bitcast<f32>(bitcast<u32>(a.x*b.x)&0xfffffffeu);
  let error=((ah*bh-p)+ah*bl+al*bh)+al*bl;
  return dsSum(p,error+a.x*b.y+a.y*b.x);
}
fn dsDiv(a:vec2f,b:vec2f)->vec2f {
  let q=a.x/b.x;let residual=dsSub(a,dsMul(b,vec2f(q,0)));
  return dsSum(q,(residual.x+residual.y)/b.x);
}
fn dsNegative(a:vec2f)->bool {return a.x<0.0 || (a.x==0.0 && a.y<0.0);}
struct DsVector {x:vec2f,y:vec2f,z:vec2f}
fn dsVector(a:vec3f)->DsVector {return DsVector(vec2f(a.x,0),vec2f(a.y,0),vec2f(a.z,0));}
fn dsVectorSub(a:vec3f,b:vec3f)->DsVector {return DsVector(dsSum(a.x,-b.x),dsSum(a.y,-b.y),dsSum(a.z,-b.z));}
fn dsCross(a:DsVector,b:DsVector)->DsVector {
  return DsVector(dsSub(dsMul(a.y,b.z),dsMul(a.z,b.y)),dsSub(dsMul(a.z,b.x),dsMul(a.x,b.z)),dsSub(dsMul(a.x,b.y),dsMul(a.y,b.x)));
}
fn dsDot(a:DsVector,b:DsVector)->vec2f {return dsAdd(dsAdd(dsMul(a.x,b.x),dsMul(a.y,b.y)),dsMul(a.z,b.z));}

fn preciseTriangleHit(ray:Ray,tri:Triangle,originLow:vec3f)->Hit {
  let e1=dsVectorSub(tri.b,tri.a);let e2=dsVectorSub(tri.c,tri.a);
  let p=dsCross(dsVector(ray.direction),e2);var det=dsDot(e1,p);
  if(all(det==vec2f(0))) {return miss(ray);}
  let base=dsVectorSub(ray.origin,tri.a);
  let s=DsVector(dsAdd(base.x,vec2f(originLow.x,0)),dsAdd(base.y,vec2f(originLow.y,0)),dsAdd(base.z,vec2f(originLow.z,0)));let q=dsCross(s,e1);
  var u=dsDot(s,p);var v=dsDot(dsVector(ray.direction),q);var t=dsDot(e2,q);
  if(dsNegative(det)) {det=-det;u=-u;v=-v;t=-t;}
  if(dsNegative(u)||dsNegative(v)||dsNegative(dsSub(det,dsAdd(u,v)))) {return miss(ray);}
  let distance=dsDiv(t,det);
  if(dsNegative(dsSub(distance,vec2f(ray.tMin,0)))||dsNegative(dsSub(vec2f(ray.tMax,0),distance))) {return miss(ray);}
  let bu=dsDiv(u,det);let bv=dsDiv(v,det);
  return Hit(distance.x,tri.id,bu.x,bv.x,NO_HIT,0u,0u,bitcast<u32>(distance.y));
}
// Once edge signs are certified, the exact plane distance avoids evaluating
// all three double-single barycentric numerators again.
fn precisePlaneDistance(ray:Ray,tri:Triangle,originLow:vec3f)->vec2f {
  let normal=dsCross(dsVectorSub(tri.b,tri.a),dsVectorSub(tri.c,tri.a));
  let base=dsVectorSub(tri.a,ray.origin);
  let delta=DsVector(dsSub(base.x,vec2f(originLow.x,0)),dsSub(base.y,vec2f(originLow.y,0)),dsSub(base.z,vec2f(originLow.z,0)));
  let denominator=dsDot(normal,dsVector(ray.direction));
  if(all(denominator==vec2f(0))) {return vec2f(FAR,0);}
  return dsDiv(dsDot(normal,delta),denominator);
}
struct SurfaceOrigin {position:vec3f,residual:vec3f}
// A sub-ULP displacement must not round the origin into a neighboring fold.
// Transport carries the residual locally; ray storage and its API stay unchanged.
fn preciseSurfaceOrigin(tri:Triangle,hit:Hit,direction:vec3f)->SurfaceOrigin {
  let e1=dsVectorSub(tri.b,tri.a);let e2=dsVectorSub(tri.c,tri.a);
  let u=vec2f(hit.u,0);let v=vec2f(hit.v,0);let normal=geometricNormal(tri);
  // Conservative gamma(32) at 44-bit precision covers the double-single
  // subtraction, products, sums and displacement (including unfused lowering).
  let error=1.8189894e-12*(dot(abs(normal),abs(tri.a)+abs(hit.u)*(abs(tri.b)+abs(tri.a))+abs(hit.v)*(abs(tri.c)+abs(tri.a)))+length(tri.b-tri.a)+length(tri.c-tri.a));
  let offset=normal*select(-error,error,dot(normal,direction)>=0.0);
  let px=dsAdd(dsAdd(vec2f(tri.a.x,0),dsAdd(dsMul(u,e1.x),dsMul(v,e2.x))),vec2f(offset.x,0));
  let py=dsAdd(dsAdd(vec2f(tri.a.y,0),dsAdd(dsMul(u,e1.y),dsMul(v,e2.y))),vec2f(offset.y,0));
  let pz=dsAdd(dsAdd(vec2f(tri.a.z,0),dsAdd(dsMul(u,e1.z),dsMul(v,e2.z))),vec2f(offset.z,0));
  return SurfaceOrigin(vec3f(px.x,py.x,pz.x),vec3f(px.y,py.y,pz.y));
}

// Dyadic weights keep the interior target exact without products or division.
fn dsInset(p:vec2f,a:f32,b:f32,c:f32,fraction:f32)->vec2f {
  let interior=dsAdd(dsSum(0.5*a,0.25*b),vec2f(0.25*c,0));
  return dsAdd(p,dsMul(vec2f(fraction,0),dsSub(interior,p)));
}

// Preserve the intersection distance tail: rounded barycentric coordinates can
// move a point through the adjacent face at a crease.
fn preciseRayOrigin(ray:Ray,low:vec3f,tri:Triangle,hit:Hit,outgoing:vec3f)->SurfaceOrigin {
  var t=vec2f(hit.t,bitcast<f32>(hit.padding));
  if(all(low==vec3f(0))) {t=precisePlaneDistance(ray,tri,low);}
  let normal=geometricNormal(tri);
  let error=1.8189894e-12*(dot(abs(normal),abs(ray.origin)+abs(ray.direction*hit.t))+length(tri.b-tri.a)+length(tri.c-tri.a));
  let offset=normal*select(-error,error,dot(normal,outgoing)>=0.0);
  var x=dsAdd(vec2f(ray.origin.x,low.x),dsMul(t,vec2f(ray.direction.x,0)));
  var y=dsAdd(vec2f(ray.origin.y,low.y),dsMul(t,vec2f(ray.direction.y,0)));
  var z=dsAdd(vec2f(ray.origin.z,low.z),dsMul(t,vec2f(ray.direction.z,0)));
  // Smooth-normal reflections in a concave crease can converge to its edge.
  // Once the hit lies inside the arithmetic uncertainty footprint, a normal
  // offset alone can cross the neighboring face. Retreat within this plane
  // by a bounded fraction toward an interior point before choosing the outgoing side.
  let a=tri.b-tri.a;let b=tri.c-tri.a;
  let edge=max(length(a),max(length(b),length(a-b)));
  let altitude=length(cross(a,b))/edge;
  let fraction=min(1.0,128.0*error/altitude);
  if(min(hit.u,min(hit.v,1.0-hit.u-hit.v))<fraction) {
    x=dsInset(x,tri.a.x,tri.b.x,tri.c.x,fraction);
    y=dsInset(y,tri.a.y,tri.b.y,tri.c.y,fraction);
    z=dsInset(z,tri.a.z,tri.b.z,tri.c.z,fraction);
  }
  x=dsAdd(x,vec2f(offset.x,0));y=dsAdd(y,vec2f(offset.y,0));z=dsAdd(z,vec2f(offset.z,0));
  return SurfaceOrigin(vec3f(x.x,y.x,z.x),vec3f(x.y,y.y,z.y));
}

fn transportOrigin(ray:Ray,low:vec3f,tri:Triangle,hit:Hit,outgoing:vec3f)->SurfaceOrigin {
  if(PRECISE_TRANSPORT) {return preciseRayOrigin(ray,low,tri,hit,outgoing);}
  return SurfaceOrigin(offsetSurface(tri,hit,outgoing),vec3f(0));
}
