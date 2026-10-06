import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const models = { suzanne: ['suzanne-original.obj', 1.2], 'suzanne-high-poly': ['Suzanne.obj', 1.2], buddha: ['Buddha.obj', 1.7], rastagotchi: ['Rastagotchi.obj', 1.2] };
let previous = {};
try { previous = JSON.parse(await readFile('src/assets/model-manifest.json', 'utf8')); } catch { /* First generation. */ }
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { parseObj } = await server.ssrLoadModule('/src/assets/obj.ts');
  const { repairMesh } = await server.ssrLoadModule('/src/assets/mesh-repair.ts');
  const { encodeMesh, decodeMesh } = await server.ssrLoadModule('/src/assets/mesh-binary.ts');
  const implementation = await Promise.all(['obj', 'polygon', 'mesh-topology', 'mesh-cleanup', 'mesh-repair', 'mesh-binary'].map(name => readFile(`src/assets/${name}.ts`)));
  await mkdir('public/models', { recursive: true });
  const manifest = {};
  for (const [id, [file, maxDimension]] of Object.entries(models)) {
    const source = await readFile(`assets/${file}`);
    const revision = createHash('sha256').update(source).update(JSON.stringify({ maxDimension, skipDegenerateTriangles: id === 'buddha' }));
    implementation.forEach(bytes => revision.update(bytes));
    const hash = revision.digest('hex');
    manifest[id] = {};
    let original;
    for (const closed of [false, true]) {
      const name = `${id}-${closed ? 'closed' : 'original'}-${hash}.mesh`;
      let bytes;
      try {
        bytes = await readFile(`public/models/${name}`);
        const expected = previous[id]?.[closed ? 'closed' : 'original'];
        if (expected?.file !== name || expected.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Stale or corrupt prepared model');
        decodeMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }
      catch {
        original ??= parseObj(source.toString('utf8'), { maxDimension, skipDegenerateTriangles: id === 'buddha' });
        bytes = Buffer.from(encodeMesh(closed ? repairMesh(original) : original));
        await writeFile(`public/models/${name}`, bytes);
      }
      manifest[id][closed ? 'closed' : 'original'] = { file: name, sha256: createHash('sha256').update(bytes).digest('hex') };
      console.log(`${id} ${closed ? 'closed' : 'original'}: ${bytes.length} bytes`);
    }
  }
  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (JSON.stringify(previous) !== JSON.stringify(manifest)) await writeFile('src/assets/model-manifest.json', json);
} finally { await server.close(); }
