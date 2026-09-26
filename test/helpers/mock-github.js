'use strict';
// A local stand-in for github.com + api.github.com used by the tests.
// It implements just enough of the OAuth and REST endpoints Traceon calls,
// and records every request so tests can assert on what Traceon sent.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const TOKEN = 'gho_MOCK_ACCESS_TOKEN_should_never_reach_browser';
const REFRESH = 'ghr_MOCK_REFRESH_TOKEN';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function tarEntry(name, data, type = '0') {
  const body = Buffer.from(data);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, body.length, type), body, pad]);
}

function paxRecord(key, value) {
  const rec = ` ${key}=${value}\n`;
  let len = rec.length + 1;
  while (String(len).length + rec.length !== len) len = String(len).length + rec.length;
  return `${len}${rec}`;
}

// Builds a GitHub-style tarball: global pax header, top-level "owner-repo-sha/" dir,
// and pax "path" records for names longer than 100 bytes.
function buildTarball(files, prefix) {
  const parts = [tarEntry('pax_global_header', paxRecord('comment', SHA), 'g')];
  for (const [p, data] of Object.entries(files)) {
    const full = `${prefix}/${p}`;
    if (Buffer.byteLength(full) > 100) {
      parts.push(tarEntry('PaxHeader', paxRecord('path', full), 'x'));
      parts.push(tarEntry(full.slice(0, 99), data));
    } else {
      parts.push(tarEntry(full, data));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

function readFixture(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

function repoMeta(name, extra = {}) {
  return {
    id: crypto.createHash('md5').update(name).digest().readUInt32BE(0),
    name, full_name: `octo-dev/${name}`, owner: { login: 'octo-dev', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    private: false, visibility: 'public', language: 'TypeScript', description: `${name} description`, default_branch: 'main',
    updated_at: '2026-09-20T10:00:00Z', pushed_at: '2026-09-24T10:00:00Z', created_at: '2025-01-01T00:00:00Z',
    stargazers_count: 3, fork: false, archived: false, size: 120, html_url: `https://github.com/octo-dev/${name}`,
    // fields that must NOT be forwarded to the browser
    permissions: { admin: true, push: true, pull: true }, ssh_url: 'git@github.com:octo-dev/x.git',
    ...extra,
  };
}

function startMockGitHub({ fixtureDir }) {
  const files = readFixture(fixtureDir);
  const longName = 'src/' + 'deeply/'.repeat(14) + 'nested-module.ts';
  files[longName] = Buffer.from("export const deep = 1;\n");
  // Hostile repository content: must be displayed as text, never executed.
  if (process.env.TRACEON_XSS_FIXTURE) {
    files['src/<img src=x onerror=window.__xss=1>.ts'] = Buffer.from("export const x = process.env.X_<b>;\n");
    const pkg = JSON.parse(files['package.json']);
    pkg.dependencies['evil-pkg'] = '<img src=x onerror=window.__xss=2>';
    pkg.dependencies['express'] = '4.17.1<img src=x onerror=window.__xss=3>';
    files['package.json'] = Buffer.from(JSON.stringify(pkg));
  }
  const tarball = buildTarball(files, `octo-dev-sample-app-${SHA.slice(0, 7)}`);

  const state = { challenges: new Map(), requests: [], revoked: [], codeloadAuthHeaders: [], writes: [] };
  const repos = {
    'sample-app': repoMeta('sample-app', process.env.TRACEON_XSS_FIXTURE ? { description: '<img src=x onerror=window.__xss=4>' } : {}),
    'empty-repo': repoMeta('empty-repo', { size: 0 }),
    'private-app': repoMeta('private-app', { private: true, visibility: 'private' }),
    'busy-repo': repoMeta('busy-repo'),
  };

  const server = http.createServer(async (req, res) => {
    const base = `http://${req.headers.host}`;
    const url = new URL(req.url, base);
    const p = url.pathname;
    let body = '';
    for await (const c of req) body += c;
    state.requests.push({ method: req.method, path: p, auth: req.headers.authorization || null });
    if (!['GET', 'HEAD'].includes(req.method) && !p.startsWith('/login/oauth/access_token') && !p.startsWith('/applications/')) {
      state.writes.push(`${req.method} ${p}`);
    }
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    const authed = () => req.headers.authorization === `Bearer ${TOKEN}`;

    // ---- OAuth (github.com) ----
    if (p === '/login/oauth/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      const st = url.searchParams.get('state');
      if (url.searchParams.get('client_id') !== 'Iv1.testclient') return json(400, { error: 'bad client' });
      if (state.denyNext) { state.denyNext = false; res.writeHead(302, { Location: `${redirect}?error=access_denied&state=${st}` }); return res.end(); }
      state.challenges.set('code-123', url.searchParams.get('code_challenge'));
      state.lastAuthorizeQuery = Object.fromEntries(url.searchParams);
      res.writeHead(302, { Location: `${redirect}?code=code-123&state=${encodeURIComponent(st)}` });
      return res.end();
    }
    if (p === '/login/oauth/access_token' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      if (b.client_id !== 'Iv1.testclient' || b.client_secret !== 'test-secret') return json(200, { error: 'incorrect_client_credentials' });
      if (b.grant_type === 'refresh_token') return json(200, { access_token: TOKEN, refresh_token: REFRESH, expires_in: 28800 });
      const challenge = state.challenges.get(b.code);
      const expected = crypto.createHash('sha256').update(b.code_verifier || '').digest('base64url');
      if (!challenge || challenge !== expected) return json(200, { error: 'bad_verification_code' });
      state.challenges.delete(b.code);
      return json(200, { access_token: TOKEN, token_type: 'bearer', scope: '', expires_in: 28800, refresh_token: REFRESH, refresh_token_expires_in: 15897600 });
    }
    if (p.startsWith('/applications/') && req.method === 'DELETE') {
      state.revoked.push(JSON.parse(body || '{}').access_token);
      res.writeHead(204); return res.end();
    }

    // ---- Signed tarball download (codeload) ----
    if (p.startsWith('/codeload/')) {
      state.codeloadAuthHeaders.push(req.headers.authorization || null);
      res.writeHead(200, { 'Content-Type': 'application/x-gzip', 'Content-Length': tarball.length });
      return res.end(tarball);
    }

    // ---- REST API ----
    if (!authed()) return json(401, { message: 'Bad credentials' });
    if (p === '/user') return json(200, { login: 'octo-dev', id: 1, name: 'Octo Dev', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', html_url: 'https://github.com/octo-dev', email: 'octo@example.com' });
    if (p === '/user/installations') return json(200, { total_count: 1, installations: [{ id: 42 }] });
    if (p === '/user/installations/42/repositories') {
      const page = +(url.searchParams.get('page') || 1);
      return json(200, { total_count: 4, repositories: page === 1 ? Object.values(repos) : [] });
    }
    const m = p.match(/^\/repos\/octo-dev\/([^/]+)(\/.*)?$/);
    if (m) {
      const [, name, rest = ''] = m;
      if (name === 'busy-repo') return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
      if (name === 'private-app') return json(404, { message: 'Not Found' });
      const meta = repos[name];
      if (!meta) return json(404, { message: 'Not Found' });
      if (!rest) return json(200, meta);
      if (name === 'empty-repo') return json(409, { message: 'Git Repository is empty.' });
      if (rest === '/commits/main') return json(200, { sha: SHA, commit: { message: 'Add billing\n\nlong body', tree: { sha: 'tree-sha' }, author: { name: 'Octo', date: '2026-09-24T10:00:00Z' } }, author: { login: 'octo-dev' } });
      if (rest === '/git/trees/tree-sha') {
        return json(200, { sha: 'tree-sha', truncated: false, tree: Object.entries(files).map(([path, data]) => ({ path, type: 'blob', size: data.length })) });
      }
      if (rest === `/tarball/${SHA}`) { res.writeHead(302, { Location: `${base}/codeload/octo-dev/sample-app/tar.gz/${SHA}?token=signed` }); return res.end(); }
    }
    json(404, { message: 'Not Found' });
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, base, state, TOKEN, REFRESH, SHA, longName, close: () => new Promise(r => server.close(r)) });
  }));
}

module.exports = { startMockGitHub, buildTarball, tarEntry, paxRecord };
