import type { ImportedObj } from './obj';
import type { RepairReport } from './mesh-repair';

export type BinaryMesh = ImportedObj & { repair?: RepairReport };
const MAGIC = 0x314d5450;
/** Lossless container: JSON metadata followed by aligned, unmodified typed arrays. */
export function encodeMesh(model: BinaryMesh): ArrayBuffer {
  const arrays = [model.mesh.positions, model.mesh.indices, model.mesh.normals, model.mesh.shells];
  const { mesh: _mesh, ...metadata } = model;
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const start = (32 + json.length + 3) & ~3;
  const result = new ArrayBuffer(start + arrays.reduce((n, a) => n + (a?.byteLength ?? 0), 0));
  const header = new DataView(result);
  header.setUint32(0, MAGIC, true); header.setUint32(4, json.length, true);
  const bytes = new Uint8Array(result); bytes.set(json, 32);
  let offset = start;
  arrays.forEach((array, i) => {
    header.setUint32(8 + i * 4, array?.length ?? 0, true);
    if (array) { bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset); offset += array.byteLength; }
  });
  return result;
}

export function decodeMesh(buffer: ArrayBuffer): BinaryMesh {
  if (buffer.byteLength < 32) throw new Error('Truncated mesh');
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== MAGIC) throw new Error('Unsupported mesh format');
  const jsonLength = header.getUint32(4, true);
  const lengths = [8, 12, 16, 20].map(offset => header.getUint32(offset, true));
  let offset = Math.ceil((32 + jsonLength) / 4) * 4;
  if (offset + lengths.reduce((a, b) => a + b * 4, 0) !== buffer.byteLength) throw new Error('Invalid mesh length');
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 32, jsonLength))) as Omit<BinaryMesh, 'mesh'>;
  const [positions, indices, normals, shells] = lengths;
  if (!positions || positions % 3 || !indices || indices % 3 || indices / 3 !== metadata.triangles ||
      (normals !== 0 && normals !== positions) || (shells !== 0 && shells !== metadata.triangles) || typeof metadata.solid !== 'boolean') throw new Error('Invalid mesh layout');
  const p = new Float32Array(buffer, offset, positions); offset += positions * 4;
  const ix = new Uint32Array(buffer, offset, indices); offset += indices * 4;
  const n = normals ? new Float32Array(buffer, offset, normals) : undefined; offset += normals! * 4;
  const s = shells ? new Uint32Array(buffer, offset, shells) : undefined;
  if (p.some(v => !Number.isFinite(v)) || n?.some(v => !Number.isFinite(v)) || ix.some(v => v >= positions / 3)) throw new Error('Invalid mesh data');
  return { ...metadata, mesh: { positions: p, indices: ix, normals: n, shells: s } };
}
