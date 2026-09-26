'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { TarExtractor } = require('../server/tar');
const { buildTarball } = require('./helpers/mock-github');

function extract(buf, chunkSize, want = () => true) {
  const out = {};
  const tar = new TarExtractor({ want, onFile: (p, b) => { out[p] = b.toString(); } });
  for (let i = 0; i < buf.length; i += chunkSize) tar.write(buf.subarray(i, i + chunkSize));
  return out;
}

test('reads files, pax long paths and skips global headers across any chunking', () => {
  const long = 'a/' + 'very-long-directory-name/'.repeat(6) + 'file.txt';
  const files = { 'README.md': '# hi\n', 'src/x.js': 'x'.repeat(1500), [long]: 'deep', 'empty.txt': '' };
  const raw = zlib.gunzipSync(buildTarball(files, 'owner-repo-abc1234'));
  for (const size of [1, 7, 512, 513, 4096, raw.length]) {
    const out = extract(raw, size);
    assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(files).map(f => 'owner-repo-abc1234/' + f).sort(), `chunk ${size}`);
    assert.strictEqual(out['owner-repo-abc1234/' + long], 'deep');
    assert.strictEqual(out['owner-repo-abc1234/src/x.js'].length, 1500);
  }
});

test('only buffers entries accepted by want()', () => {
  const raw = zlib.gunzipSync(buildTarball({ 'keep.js': 'k', 'skip.bin': 'zzzz' }, 'r'));
  const seen = [];
  const out = extract(raw, 100, (p, size) => { seen.push([p, size]); return p.endsWith('.js'); });
  assert.deepStrictEqual(Object.keys(out), ['r/keep.js']);
  assert.deepStrictEqual(seen, [['r/keep.js', 1], ['r/skip.bin', 4]]);
});
