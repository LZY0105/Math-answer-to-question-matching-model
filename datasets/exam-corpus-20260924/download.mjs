#!/usr/bin/env node
import { run } from '../books-20260924/download.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifest.json');
run(process.argv.slice(2), { manifestPath }).catch(error => {
  console.error('Download failed: ' + error.message);
  process.exitCode = 1;
});
