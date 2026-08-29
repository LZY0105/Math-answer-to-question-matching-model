#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SCENARIOS, runScenario } from './scenarios.mjs';


const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'demo', 'public');
const PDF = join(ROOT, 'output', 'pdf', 'demo');
const TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
});


function portFrom(argv) {
  const at = argv.indexOf('--port');
  const value = at >= 0 ? argv[at + 1] : process.env.PORT;
  const port = Number(value ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}


function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}


async function serveFile(response, root, relative) {
  const safe = normalize(relative).replace(/^(\.\.(\\|\/|$))+/, '');
  const file = join(root, safe);
  if (!file.startsWith(root)) return json(response, 403, { error: 'Forbidden' });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': extname(file) === '.pdf' ? 'public, max-age=3600' : 'no-cache',
    });
    createReadStream(file).pipe(response);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
}


export function createDemoServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/scenarios') {
        return json(response, 200, Object.values(SCENARIOS).map(({ id, title, description, exercise, answer }) => ({
          id, title, description,
          exercise: exercise.split(/[\\/]/).at(-1),
          answer: answer.split(/[\\/]/).at(-1),
        })));
      }
      if (url.pathname === '/api/run') {
        const scenario = url.searchParams.get('scenario') ?? 'correct';
        if (!SCENARIOS[scenario]) return json(response, 400, { error: `Unknown scenario: ${scenario}` });
        return json(response, 200, await runScenario(scenario));
      }
      if (url.pathname.startsWith('/fixtures/')) {
        return serveFile(response, PDF, url.pathname.slice('/fixtures/'.length));
      }
      if (url.pathname === '/') return serveFile(response, PUBLIC, 'index.html');
      return serveFile(response, PUBLIC, url.pathname.slice(1));
    } catch (error) {
      return json(response, 500, { error: error.message });
    }
  });
}


export function startDemoServer({ port = portFrom(process.argv.slice(2)) } = {}) {
  const server = createDemoServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log(`Find-Engine demo: http://127.0.0.1:${address.port}`);
    console.log('Press Ctrl+C to stop.');
  });
  return server;
}


if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startDemoServer();
}
