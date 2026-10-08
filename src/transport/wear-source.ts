import wear from './surface-wear.wgsl?raw';

/** Remove inactive procedural code before driver compilation. */
export function specializeSurfaceWear(source: string, mask: number): string {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new Error('Invalid wear mask');
  let specialized = wear.replace('const WEAR_MASK=7u;', `const WEAR_MASK=${mask}u;`);
  for (let effect = 0; effect < 3; effect++) {
    if (!(mask & (1 << effect))) specialized = specialized.replace(
      new RegExp(`// wear-begin-${effect}[\\s\\S]*?// wear-end-${effect}`), '');
  }
  if (!mask) specialized = `
struct WearSurface { roughness: f32, normal: vec3f }
fn dielectricWear(material: Material, position: vec3f, geometric: vec3f, shading: vec3f) -> WearSurface {
  return WearSurface(material.textureParams.x, shading);
}
fn wornMaterial(material: Material, position: vec3f, geometric: vec3f) -> Material { return material; }
`;
  if (!source.includes(wear)) throw new Error('Surface wear source missing');
  return source.replace(wear, specialized);
}
