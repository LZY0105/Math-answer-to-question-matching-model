#!/usr/bin/env node
// Node >=18. Downloads are opt-in; the default action only lists the manifest.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const manifestPath = fileURLToPath(new URL('./manifest.json', import.meta.url));
const help = 'Usage: node download.mjs [--list | --all | --id ID [ID ...]] [--out DIRECTORY]\n'
  + 'Repeat --id to select more books. With no selection, only list files.\n'
  + 'Downloads use original names and are checked against manifest SHA-256 and byte counts.';

function parseArgs(argv) {
  const options = { ids: [], all: false, list: false, out: path.join(path.dirname(manifestPath), 'downloads') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--out requires a directory.');
      options.out = argv[++i];
    } else if (arg === '--id') {
      const start = options.ids.length;
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) options.ids.push(argv[++i]);
      if (options.ids.length === start) throw new Error('--id requires at least one ID.');
    } else throw new Error('Unknown argument: ' + arg);
  }
  if (options.all && options.ids.length) throw new Error('Use either --all or --id.');
  if (options.list && (options.all || options.ids.length)) throw new Error('--list cannot be combined with a download selection.');
  return options;
}

function safeName(value, field) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    || path.posix.basename(value) !== value || path.win32.basename(value) !== value) {
    throw new Error('Unsafe manifest ' + field + '.');
  }
  return value;
}

function localOrigin(testHttpOrigin) {
  if (!testHttpOrigin) return null;
  const url = new URL(testHttpOrigin);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Test HTTP origin must be an explicit loopback origin.');
  }
  return url.origin;
}

function parseUrl(value) {
  if (typeof value !== 'string') throw new Error('Manifest downloadUrl must be a URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid download URL.'); }
  if (url.username || url.password || url.hash) throw new Error('Credentials and fragments are not allowed in download URLs.');
  return url;
}

function validateInitialUrl(value, assetName, testOrigin) {
  const url = parseUrl(value);
  if (testOrigin && url.origin === testOrigin) return url;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.search) {
    throw new Error('Downloads must use an HTTPS GitHub Release asset URL.');
  }
  const parts = url.pathname.split('/');
  if (parts.length !== 7 || parts[0] !== '' || parts[3] !== 'releases' || parts[4] !== 'download'
    || !parts[1] || !parts[2] || !parts[5] || !parts[6]) {
    throw new Error('Expected /OWNER/REPO/releases/download/TAG/ASSET.');
  }
  let decoded;
  try { decoded = parts.slice(1).map(decodeURIComponent); } catch { throw new Error('Invalid URL escaping.'); }
  if (decoded.some(part => part === '.' || part === '..' || /[/\\\x00-\x1f]/.test(part))
    || decoded[5] !== assetName) {
    throw new Error('Release URL path or assetName is inconsistent.');
  }
  return url;
}

function validateRedirectUrl(value, testOrigin) {
  const url = parseUrl(value);
  if (testOrigin && url.origin === testOrigin) return url;
  if (url.protocol !== 'https:' || url.port
    || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    throw new Error('Refusing a redirect outside the GitHub asset hosts.');
  }
  return url;
}

function validateManifest(manifest, testOrigin) {
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('Manifest must contain a files array.');
  const ids = new Set();
  const names = new Set();
  return manifest.files.map(file => {
    if (!file || typeof file.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.id)
      || ids.has(file.id)) throw new Error('Invalid or duplicate manifest ID.');
    ids.add(file.id);
    const originalName = safeName(file.originalName, 'originalName');
    const assetName = safeName(file.assetName, 'assetName');
    const folded = originalName.toLowerCase();
    if (names.has(folded)) throw new Error('Duplicate output filename in manifest.');
    names.add(folded);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid manifest byte count.');
    if (typeof file.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest SHA-256.');
    const url = validateInitialUrl(file.downloadUrl, assetName, testOrigin);
    return { ...file, originalName, assetName, sha256: file.sha256.toLowerCase(), url };
  });
}

async function fingerprint(filename) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function matchingExisting(destination, file) {
  let stat;
  try { stat = await lstat(destination); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) {
    throw new Error('Existing destination does not match; refusing to overwrite: ' + file.originalName);
  }
  const actual = await fingerprint(destination);
  if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
    throw new Error('Existing destination does not match; refusing to overwrite: ' + file.originalName);
  }
  return true;
}

async function fetchAsset(url, testOrigin) {
  const signal = AbortSignal.timeout(30 * 60 * 1000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      redirect: 'manual', signal,
      headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('Missing redirect location or too many redirects.');
      url = validateRedirectUrl(new URL(location, url).href, testOrigin);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Asset request failed with HTTP ' + response.status + '.');
    }
    return response;
  }
  throw new Error('Too many redirects.');
}

async function download(file, outputDirectory, testOrigin) {
  const destination = path.resolve(outputDirectory, file.originalName);
  if (path.dirname(destination) !== outputDirectory) throw new Error('Destination escapes output directory.');
  if (await matchingExisting(destination, file)) return 'SKIP';
  const temporary = path.join(outputDirectory, '.download-' + randomUUID() + '.part');
  let ownsTemporary = false;
  try {
    const response = await fetchAsset(file.url, testOrigin);
    const hash = createHash('sha256');
    let bytes = 0;
    const checker = new Transform({
      transform(chunk, encoding, done) {
        bytes += chunk.length;
        if (bytes > file.bytes) return done(new Error('Downloaded byte count exceeds manifest: ' + file.id));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    output.once('open', () => { ownsTemporary = true; });
    await pipeline(Readable.fromWeb(response.body), checker, output);
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) {
      throw new Error('Downloaded SHA-256 or byte count mismatch: ' + file.id);
    }
    // A hard link publishes the verified file atomically and never overwrites a
    // destination created by another downloader. Both paths are on the same disk.
    try { await link(temporary, destination); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await matchingExisting(destination, file)) return 'SKIP';
      throw new Error('Destination changed while publishing: ' + file.originalName);
    }
    return 'OK';
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Test injection is programmatic only; the CLI never enables HTTP downloads.
export async function run(argv = [], options = {}) {
  const args = parseArgs(argv);
  const log = options.log ?? console.log;
  if (args.help) { log(help); return; }
  const testOrigin = localOrigin(options.testHttpOrigin);
  const manifest = JSON.parse(await readFile(options.manifestPath ?? manifestPath, 'utf8'));
  const files = validateManifest(manifest, testOrigin);
  if (!args.all && args.ids.length === 0) {
    for (const file of files) log(file.id + '\t' + file.bytes + ' bytes\t' + file.originalName);
    log('Listed ' + files.length + ' file(s). Use --id ID or --all to download.');
    return;
  }
  const wanted = new Set(args.ids);
  for (const id of wanted) if (!files.some(file => file.id === id)) throw new Error('Unknown file ID: ' + id);
  const selected = args.all ? files : files.filter(file => wanted.has(file.id));
  const outputDirectory = path.resolve(args.out);
  await mkdir(outputDirectory, { recursive: true });
  for (const file of selected) {
    const status = await download(file, outputDirectory, testOrigin);
    log(status + '\t' + file.id + '\t' + file.originalName);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).catch(error => {
    console.error('Download failed: ' + error.message);
    process.exitCode = 1;
  });
}

