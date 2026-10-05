import threadedBvh from "./threaded-bvh.wgsl?raw";

/** Build the ordinary kernel without compensated-origin state or double-single
 * calls. Numerically uncertain paths are replayed by the independent precise
 * kernel with the same samples, before accumulation/photon hashing.
 */
export function fastTransportShader(source: string, threadedTraversal = false): string {
  let fast = source.replace(/override PRECISE_TRANSPORT: bool = true;[\s\S]*?(?=const NO_HIT:)/,
    'const PRECISE_TRANSPORT: bool = false;\n');
  fast = fast
    .replace(/^  if\(PRECISE_TRANSPORT\) \{[\s\S]*?\r?\n  }/gm, '')
    .replace(/    if\(PRECISE_TRANSPORT\) \{return preciseTriangleHit[^\r\n]+[\r\n]+/, '')
    .replace(/  if\(PRECISE_TRANSPORT && any\(originLow[\s\S]*?\r?\n  }/, '')
    .replace(/          hit=preciseTriangleHit\(bounded,[\s\S]*?          closer=[^\r\n]+[\r\n]+/, '')
    .replace(/,\s*originLow:vec3f/g, '')
    .replaceAll('triangles[i], shear,originLow', 'triangles[i], shear')
    .replaceAll('rayShear(ray.direction),vec3f(0)', 'rayShear(ray.direction)')
    .replaceAll('traceBvh(ray, false,vec3f(0))', 'traceBvh(ray, false)')
    .replaceAll('traceBvh(ray, false,originLow)', 'traceBvh(ray, false)')
    .replaceAll('traceBvh(ray, true,vec3f(0))', 'traceBvh(ray, true)')
    .replace(/var originLow\s*=\s*vec3f\(0\);/g, '')
    .replaceAll('closestHitWithOrigin(ray,originLow)', 'closestHit(ray)')
    .replaceAll('originLow=vec3f(0);', '')
    .replace(/let origin=transportOrigin\(ray,originLow,triangle,hit,event.direction\);\s*ray\s*=\s*Ray\(origin.position,\s*0.0,\s*event.direction,\s*1e20\);originLow=origin.residual;/g,
      'ray=Ray(offsetSurface(triangle,hit,event.direction),0.0,event.direction,1e20);')
    .replace(/    if\(material.kind==2u(?:\|\|material.kind==5u)?\) \{let origin=transportOrigin[^\r\n]+[\r\n]+    else \{ray=Ray\(offsetSurface\(triangle,hit,wi\),0.0,wi,1e20\);}/,
      '    ray=Ray(offsetSurface(triangle,hit,wi),0.0,wi,1e20);');
  fast=fast.replace('        var closer=hit.t<best.t;', '')
    .replace('(best.id == NO_HIT || closer || (hit.t == best.t && bitcast<f32>(hit.padding)==bitcast<f32>(best.padding) && hit.id < best.id))',
      '(best.id == NO_HIT || hit.t<best.t || (hit.t==best.t && hit.id<best.id))');
  if(threadedTraversal) {
    fast=fast.replace(/^fn traceBvh\([\s\S]*?^}/m, threadedBvh);
  } else {
    // Local error bounds are tighter for short interior photon rays. The
    // explicit crease guard accounts for reconstruction of each spawned origin.
    fast=fast.replace('  var coordinateError=shear.coordinateError;',
      '  let translated=max(abs(a),max(abs(b),abs(c)));\n  let coordinateError=5.364421e-7*max(translated.x,max(translated.y,translated.z))*(1.0+max(abs(sx),abs(sy)));');
  }
  if (/originLow|preciseTriangleHit|precisePlaneDistance|transportOrigin|dsMul/.test(fast))
    throw new Error('Common transport specialization left precision state');
  return fast;
}
