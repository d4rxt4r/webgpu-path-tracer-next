import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseObj } from '../src/assets/obj';
import { repairMesh } from '../src/assets/mesh-repair';
import { encodeMesh, decodeMesh } from '../src/assets/mesh-binary';

it('preserves original and repaired mesh bits and metadata', () => {
  const source = parseObj(readFileSync(new URL('fixtures/solid.obj', import.meta.url), 'utf8'));
  for (const model of [source, repairMesh(source)]) {
    const decoded = decodeMesh(encodeMesh(model));
    expect(decoded).toEqual(model);
    for (const key of ['positions', 'indices', 'normals', 'shells'] as const) {
      const a = model.mesh[key], b = decoded.mesh[key];
      if (a && b) expect(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).toEqual(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    }
  }
});
it('rejects truncated, unsupported and malformed binary meshes', () => {
  const model = parseObj(readFileSync(new URL('fixtures/solid.obj', import.meta.url), 'utf8'));
  const bytes = encodeMesh(model);
  expect(() => decodeMesh(bytes.slice(0, -1))).toThrow();
  new DataView(bytes).setUint32(8, 0, true);
  expect(() => decodeMesh(bytes)).toThrow();
  expect(() => decodeMesh(new ArrayBuffer(32))).toThrow();
});
