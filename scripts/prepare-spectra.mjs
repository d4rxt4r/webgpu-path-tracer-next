import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const revision = 'b4ce9687e6c695f5582997c61b0c66cf064bdb4a';
const source = `https://raw.githubusercontent.com/mmp/pbrt-v4/${revision}/src/pbrt/util/spectrum.cpp`;
const response = await fetch(source);
if (!response.ok) throw new Error(`Spectral source: HTTP ${response.status}`);
const text = await response.text();
function table(name) {
  const body = text.match(new RegExp(`const Float ${name}\\[[^\\]]*\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`))?.[1];
  if (!body) throw new Error(`Missing table ${name}`);
  return body.replace(/\/\/[^\n]*/g, '').split(',').map(v => v.trim()).filter(Boolean).map(Number);
}
const x = table('CIE_X'), y = table('CIE_Y'), z = table('CIE_Z'), d65 = table('CIE_Illum_D6500');
if ([x,y,z].some(v => v.length !== 471 || v.some(n => !Number.isFinite(n))) || d65.length % 2 || d65.some(n => !Number.isFinite(n))) throw new Error('Invalid spectral source dimensions');
const data = JSON.stringify({ x, y, z, d65 }) + '\n';
await writeFile(new URL('../src/assets/spectral-data.json', import.meta.url), data);
const meta = JSON.stringify({ source, revision, sha256: createHash('sha256').update(data).digest('hex'), observer: 'CIE 1931 2 degree, 360-830 nm at 1 nm', illuminant: 'D65, piecewise linear; normalized to Y=1', license: 'Apache-2.0, see pbrt-LICENSE.txt', glass: { source: 'https://www.schott.com/en-gb/products/optical-glass/-/media/Project/OnEx/Products/O/optical-glass/Downloads/schott-optical-glass-collection-datasheets-english-may2019.pdf?rev=5358bb64e13a44f2b37f5065490509af', page: 13, type: 'N-BK7', B: [1.03961212,0.231792344,1.01046945], C: [0.00600069867,0.0200179144,103.560653], wavelengthUnit: 'micrometer', internalTransmittanceThicknessMeters: 0.01, internalTransmittance: [[350,0.967],[365,0.988],[370,0.991],[380,0.993],[390,0.996],[400,0.997],[405,0.997],[420,0.997],[436,0.997],[460,0.997],[500,0.998],[546,0.998],[580,0.998],[620,0.998],[660,0.998],[700,0.998],[1060,0.999]], interpolation: 'piecewise linear absorption coefficient -ln(tau)/0.01 m', temperature: 'nominal datasheet values; no thermal model' }, walls: 'Synthetic tabulated demonstration reflectances; not measured Cornell data' }, null, 2) + '\n';
await Promise.all([writeFile(new URL('../public/assets/spectra.json', import.meta.url), meta), writeFile(new URL('../src/assets/spectral-meta.json', import.meta.url), meta)]);
await writeFile(new URL('../public/assets/spectra-NOTICE.txt', import.meta.url), text.slice(0,text.indexOf('#include')).trimEnd() + '\n\nCIE and D65 tables extracted from the pinned PBRT source above.\nSee pbrt-LICENSE.txt for the full Apache-2.0 license.\n');
console.log('Prepared 471-sample CIE curves and D65 from pinned PBRT source');
