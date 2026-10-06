import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read-only Git snapshot; served by the existing Vite instance. No browser launch.
const commit=process.argv[2] ?? '6a0c8be';
const directory='test-results/performance';
const revision = Date.now();
const files={
  'src/app/main.ts':'original-main.ts',
  'src/render/intersection-renderer.ts':'original-renderer.ts',
  'src/assets/builtin-obj.ts':'original-builtin.ts',
  'src/assets/prepare.ts':'original-prepare.ts',
  'src/accel/prepare.worker.ts':'original-worker.ts',
};
await mkdir(directory,{recursive:true});
for(const [file,name] of Object.entries(files)) {
  const source=execFileSync('git',['show',`${commit}:${file}`],{encoding:'utf8'});
  const rewritten=source.replace(/(['"])(\.\.?\/[^'"]+)\1/g,(match,quote,specifier)=>{
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
    const replacement = files[resolved] ?? files[resolved + '.ts'];
    return quote+(replacement ? '/'+directory+'/'+replacement+'?baseline='+revision : '/'+resolved)+quote;
  });
  await writeFile(path.join(directory,name),rewritten);
}
await writeFile(path.join(directory,'original.html'),`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="./original-main.ts?baseline=${revision}"></script></body></html>`);
console.log(`Prepared ${commit} startup baseline in ${directory}/original.html`);
