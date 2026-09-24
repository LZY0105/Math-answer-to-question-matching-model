// Run: node --test datasets/books-20260924/download.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { run } from './download.mjs';

const payload = Buffer.from('%PDF-1.4\nlocal fixture\n');
const sha256 = createHash('sha256').update(payload).digest('hex');

test('local HTTP fixtures: safe verified downloads and failure isolation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-download-test-'));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/fixture.pdf' });
      response.end();
    } else if (request.url === '/bad-redirect') {
      response.writeHead(302, { location: 'http://example.com/fixture.pdf' });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(payload);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // root is created by mkdtemp, with a fixed task-specific prefix under tmp.
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('book-download-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const record = {
    id: 'book-001', originalName: '\u6570\u5b66\u5206\u6790 \u4e60\u9898.pdf',
    assetName: 'book-001.pdf', bytes: payload.length, sha256,
    downloadUrl: origin + '/fixture.pdf',
  };
  async function fixture(name, changes = {}, extra = []) {
    const manifestPath = path.join(root, name + '.json');
    const out = path.join(root, name);
    await writeFile(manifestPath, JSON.stringify({ files: [{ ...record, ...changes }, ...extra] }));
    return { out, options: { manifestPath, testHttpOrigin: origin, log: () => {} } };
  }

  await t.test('default/list do not download or create output directories', async () => {
    const { out, options } = await fixture('list');
    const before = requests;
    await run(['--out', out], options);
    await run(['--list', '--out', out], options);
    assert.equal(requests, before);
    assert.ok(!(await readdir(root)).includes('list'));
  });
  await t.test('success restores Chinese original name; matching existing file skips network', async () => {
    const { out, options } = await fixture('success', { downloadUrl: origin + '/redirect' });
    await run(['--id', 'book-001', '--out', out], options);
    assert.deepEqual(await readFile(path.join(out, record.originalName)), payload);
    assert.deepEqual(await readdir(out), [record.originalName]);
    const before = requests;
    await run(['--all', '--out', out], options);
    assert.equal(requests, before);
  });
  await t.test('wrong hash and wrong byte count leave no final or temporary files', async () => {
    for (const [name, changes] of [
      ['hash', { sha256: '0'.repeat(64) }],
      ['short', { bytes: payload.length + 1 }],
      ['long', { bytes: payload.length - 1 }],
    ]) {
      const { out, options } = await fixture(name, changes);
      await assert.rejects(run(['--all', '--out', out], options), /mismatch|exceeds/);
      assert.deepEqual(await readdir(out), []);
    }
  });
  await t.test('mismatching existing file is never overwritten', async () => {
    const { out, options } = await fixture('existing');
    await run(['--all', '--out', out], options);
    const destination = path.join(out, record.originalName);
    const wrong = Buffer.alloc(payload.length, 65);
    await writeFile(destination, wrong);
    const before = requests;
    await assert.rejects(run(['--all', '--out', out], options), /refusing to overwrite/);
    assert.deepEqual(await readFile(destination), wrong);
    assert.equal(requests, before);
  });
  await t.test('rejects traversal, absolute paths, ADS, device names and invalid assets', async () => {
    for (const originalName of ['../escape.pdf', '..\\escape.pdf', '/escape.pdf', 'C:\\escape.pdf', 'a:b.pdf', 'CON.pdf', 'x.pdf.', 'x.pdf ']) {
      const { out, options } = await fixture('unsafe', { originalName });
      await assert.rejects(run(['--all', '--out', out], options), /Unsafe manifest/);
      assert.ok(!(await readdir(root)).includes('unsafe'));
    }
    const { out, options } = await fixture('unsafe-asset', { assetName: '../book.pdf' });
    await assert.rejects(run(['--all', '--out', out], options), /Unsafe manifest/);
  });
  await t.test('HTTP injection is explicit; credentials and off-host redirects are rejected', async () => {
    const { out, options } = await fixture('url');
    await assert.rejects(run(['--all', '--out', out], { ...options, testHttpOrigin: undefined }), /HTTPS GitHub/);
    const credentials = await fixture('credentials', { downloadUrl: origin.replace('http://', 'http://user:secret@') + '/fixture.pdf' });
    await assert.rejects(run(['--all', '--out', credentials.out], credentials.options), /Credentials/);
    const redirect = await fixture('redirect-blocked', { downloadUrl: origin + '/bad-redirect' });
    await assert.rejects(run(['--all', '--out', redirect.out], redirect.options), /outside the GitHub/);
    assert.deepEqual(await readdir(redirect.out), []);
  });
  await t.test('production URLs must be GitHub release assets with matching asset names', async () => {
    for (const downloadUrl of [
      'https://example.com/book-001.pdf',
      'https://github.com/owner/repo/blob/main/book-001.pdf',
      'https://github.com/owner/repo/releases/download/v1/wrong.pdf',
    ]) {
      const { options } = await fixture('invalid-production-url', { downloadUrl });
      await assert.rejects(run(['--list'], options), /GitHub|Expected|inconsistent/);
    }
    const { options } = await fixture('valid-production-url', {
      downloadUrl: 'https://github.com/owner/repo/releases/download/v1/book-001.pdf',
    });
    await run(['--list'], { ...options, testHttpOrigin: undefined });
  });
  await t.test('multiple IDs work, unknown IDs and ambiguous flags fail before requests', async () => {
    const second = { ...record, id: 'book-002', originalName: 'second.pdf', assetName: 'book-002.pdf' };
    const { out, options } = await fixture('multi', {}, [second]);
    await run(['--id', 'book-001', '--id', 'book-002', '--out', out], options);
    assert.equal((await readdir(out)).length, 2);
    await run(['--id', 'book-001', 'book-002', '--out', out], options);
    const before = requests;
    await assert.rejects(run(['--id', 'missing', '--out', out], options), /Unknown file ID/);
    await assert.rejects(run(['--all', '--id', 'book-001'], options), /either/);
    assert.equal(requests, before);
  });
  await t.test('concurrent publishers never replace a destination', async () => {
    const { out, options } = await fixture('concurrent');
    await Promise.all([run(['--all', '--out', out], options), run(['--all', '--out', out], options)]);
    assert.deepEqual(await readFile(path.join(out, record.originalName)), payload);
    assert.deepEqual(await readdir(out), [record.originalName]);
  });
  await t.test('CLI reports invalid arguments with nonzero exit', async () => {
    const script = fileURLToPath(new URL('./download.mjs', import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, [script, '--unknown']), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown argument/);
      return true;
    });
  });
});

