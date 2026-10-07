// Local sink for the connected browser's benchmark and image artifacts.
// No browser is launched; serve Vite separately and call benchmarkMedia there.
import {createServer} from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';

const directory = resolve('docs/validation/medium-performance');
await mkdir(directory, {recursive:true});
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5360');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {response.writeHead(204);response.end();return;}
  const name = request.url?.slice(1);
  if (request.method !== 'POST' || !name || !/^[a-z0-9][a-z0-9.-]*$/i.test(name)) {
    response.writeHead(400);response.end('Invalid artifact name');return;
  }
  try {
    const chunks = [];let size = 0;
    for await (const chunk of request) {
      size += chunk.length;if (size > 64 * 1048576) throw Error('Artifact too large');
      chunks.push(chunk);
    }
    await writeFile(join(directory, name), Buffer.concat(chunks));
    response.writeHead(201);response.end('Saved');
  } catch (error) {response.writeHead(500);response.end(error.message);}
});
server.listen(5361, '127.0.0.1', () => console.log(`Media artifacts: ${directory}`));
