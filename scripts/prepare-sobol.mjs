import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const revision = 'b4ce9687e6c695f5582997c61b0c66cf064bdb4a';
const url = `https://raw.githubusercontent.com/mmp/pbrt-v4/${revision}/src/pbrt/util/sobolmatrices.cpp`;
const response = await fetch(url);
if (!response.ok) throw new Error(`Sobol source: HTTP ${response.status}`);
const source = await response.text();
const table = source.match(/SobolMatrices32[^=]*=\s*\{([\s\S]*?)\};/)?.[1];
if (!table) throw new Error('Sobol matrix table missing');
const values = [...table.matchAll(/0x[0-9a-f]+/gi)].map(match => parseInt(match[0], 16));
if (values.length !== 1024 * 52) throw new Error('Unexpected Sobol matrix dimensions');
// 512 dimensions, 32 index bits: enough for fixed dimensions through 64 bounces.
const data = Buffer.alloc(512 * 32 * 4);
for (let dim = 0; dim < 512; dim++) for (let bit = 0; bit < 32; bit++) data.writeUInt32LE(values[dim * 52 + bit], (dim * 32 + bit) * 4);
await mkdir(new URL('../public/assets/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/assets/sobol.bin', import.meta.url), data);
await writeFile(new URL('../public/assets/sobol.json', import.meta.url), JSON.stringify({ source: url, revision, dimensions: 512, bits: 32, byteOrder: 'little-endian', sha256: createHash('sha256').update(data).digest('hex'), attribution: 'Joe and Kuo direction numbers, PBRT table by Leonhard Gruenschloss; see sobol-LICENSE.txt' }, null, 2) + '\n');
// Preserve the complete notices from the source file, including its MIT notice.
await writeFile(new URL('../public/assets/sobol-LICENSE.txt', import.meta.url), source.slice(0, source.indexOf('#include')).trimEnd() + '\n');
const licenseResponse = await fetch(`https://raw.githubusercontent.com/mmp/pbrt-v4/${revision}/LICENSE.txt`);
if (!licenseResponse.ok) throw new Error(`PBRT license: HTTP ${licenseResponse.status}`);
await writeFile(new URL('../public/assets/pbrt-LICENSE.txt', import.meta.url), await licenseResponse.text());
console.log(`Prepared ${data.length} bytes of Sobol directions from ${revision}`);
