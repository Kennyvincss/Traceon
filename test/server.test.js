'use strict';
// End-to-end tests of the Traceon server against a local GitHub stand-in:
// OAuth sign-in, session handling, repository listing and scanning.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { createApp } = require('../server/index');
const { loadConfig } = require('../server/config');
const { startMockGitHub } = require('./helpers/mock-github');

async function startTraceon(gh, envOverrides = {}) {
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = loadConfig({
    APP_URL: base, GITHUB_AUTH_MODE: 'app', GITHUB_CLIENT_ID: 'Iv1.testclient', GITHUB_CLIENT_SECRET: 'test-secret',
    GITHUB_APP_SLUG: 'traceon-test', GITHUB_WEB_BASE: gh.base, GITHUB_API_BASE: gh.base, ...envOverrides,
  });
  server.on('request', createApp({ cfg }));
  return { base, cfg, close: () => new Promise(r => server.close(r)) };
}

function cookiesFrom(resp) {
  return (resp.headers.getSetCookie ? resp.headers.getSetCookie() : []).map(c => c.split(';')[0]);
}

class Browser {
  constructor(base) { this.base = base; this.jar = {}; this.bodies = []; }
  cookieHeader() { return Object.entries(this.jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; '); }
  async get(url, opts = {}) {
    const full = url.startsWith('http') ? url : this.base + url;
    const sameSite = full.startsWith(this.base);
    const resp = await fetch(full, { redirect: 'manual', ...opts, headers: { ...(sameSite ? { cookie: this.cookieHeader() } : {}), ...(opts.headers || {}) } });
    if (sameSite) for (const c of cookiesFrom(resp)) { const [k, v] = c.split('='); this.jar[k] = v; }
    const text = resp.status >= 300 && resp.status < 400 ? '' : await resp.text();
    if (sameSite) this.bodies.push(text + JSON.stringify([...resp.headers]));
    return { resp, text, json: () => JSON.parse(text), location: resp.headers.get('location') };
  }
  async signIn() {
    const start = await this.get('/auth/github/login');
    const atGitHub = await this.get(start.location);
    return this.get(atGitHub.location);
  }
}

async function scan(browser, repo) {
  const r = await browser.get(`/api/repos/octo-dev/${repo}/scan?ref=main`);
  return { status: r.resp.status, events: r.text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
}

let gh, app;
test.before(async () => {
  gh = await startMockGitHub({ fixtureDir: path.join(__dirname, 'fixtures/sample-repo') });
  app = await startTraceon(gh);
});
test.after(async () => { await app.close(); await gh.close(); });

test('serves the UI with security headers', async () => {
  const b = new Browser(app.base);
  const r = await b.get('/');
  assert.strictEqual(r.resp.status, 200);
  assert.match(r.text, /Continue with GitHub/);
  assert.match(r.resp.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.strictEqual(r.resp.headers.get('referrer-policy'), 'no-referrer');
});

test('serves the favicon and home-screen icons', async () => {
  const b = new Browser(app.base);
  for (const [path, type] of [['/favicon.svg', 'image/svg+xml'], ['/favicon.ico', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
    const r = await b.get(path);
    assert.strictEqual(r.resp.status, 200, path);
    assert.strictEqual(r.resp.headers.get('content-type'), type, path);
  }
  const html = (await b.get('/')).text;
  assert.match(html, /<link rel="icon" type="image\/svg\+xml"/);
  assert.match(html, /<link rel="apple-touch-icon"/);
});

test('login redirects to GitHub with state + PKCE and no secret', async () => {
  const b = new Browser(app.base);
  const r = await b.get('/auth/github/login');
  assert.strictEqual(r.resp.status, 302);
  const loc = new URL(r.location);
  assert.strictEqual(loc.origin + loc.pathname, `${gh.base}/login/oauth/authorize`);
  assert.strictEqual(loc.searchParams.get('client_id'), 'Iv1.testclient');
  assert.strictEqual(loc.searchParams.get('redirect_uri'), `${app.base}/auth/github/callback`);
  assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('state').length >= 32);
  assert.ok(!r.location.includes('test-secret'));
  assert.strictEqual(loc.searchParams.get('scope'), null, 'GitHub App permissions come from the app, not scopes');
  const oauthCookie = r.resp.headers.getSetCookie().find(c => c.startsWith('traceon_oauth='));
  assert.match(oauthCookie, /HttpOnly/);
  assert.match(oauthCookie, /SameSite=Lax/);
});

test('full sign-in → repositories → scan, without ever exposing the token', async () => {
  const b = new Browser(app.base);
  assert.strictEqual((await b.get('/api/session')).json().authenticated, false);

  const cb = await b.signIn();
  assert.strictEqual(cb.location, '/?github=connected');
  const sid = cb.resp.headers.getSetCookie().find(c => c.startsWith('traceon_sid='));
  assert.match(sid, /HttpOnly/);
  assert.match(sid, /SameSite=Lax/);

  const session = (await b.get('/api/session')).json();
  assert.deepStrictEqual(session.user, { login: 'octo-dev', name: 'Octo Dev', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', html_url: 'https://github.com/octo-dev' });
  assert.strictEqual(session.installUrl, `${gh.base}/apps/traceon-test/installations/new`);

  const repos = (await b.get('/api/repos')).json().repositories;
  assert.deepStrictEqual(repos.map(r => r.name).sort(), ['busy-repo', 'empty-repo', 'private-app', 'sample-app']);
  assert.ok(repos.every(r => !('permissions' in r) && !('ssh_url' in r)), 'only safe repo fields');
  assert.strictEqual(repos.find(r => r.name === 'private-app').visibility, 'private');

  const { status, events } = await scan(b, 'sample-app');
  assert.strictEqual(status, 200);
  const stages = events.filter(e => e.type === 'stage' && e.state === 'done').map(e => e.id);
  for (const id of ['s-connect', 's-tree', 's-manifest', 's-tests', 's-docs', 's-config', 's-deploy']) assert.ok(stages.includes(id), id);
  const model = events.find(e => e.type === 'result').model;
  assert.strictEqual(model.fullName, 'octo-dev/sample-app');
  assert.strictEqual(model.commit.sha, gh.SHA);
  assert.strictEqual(model.analysis.mode, 'archive');
  assert.ok(model.allFiles.includes(gh.longName), 'pax long path read from tarball');
  assert.ok(model.routes.some(r => r.path === '/billing/charge'));
  assert.ok(model.modules.length >= 3);

  // The signed download URL must not receive the user's token.
  assert.deepStrictEqual(gh.state.codeloadAuthHeaders, [null]);
  // Nothing Traceon returned to the browser contains the GitHub token or secret.
  for (const body of b.bodies) {
    assert.ok(!body.includes(gh.TOKEN), 'access token leaked');
    assert.ok(!body.includes(gh.REFRESH), 'refresh token leaked');
    assert.ok(!body.includes('test-secret'), 'client secret leaked');
  }
});

test('maps repository errors to safe codes', async () => {
  const b = new Browser(app.base);
  await b.signIn();
  const code = async repo => (await scan(b, repo)).events.find(e => e.type === 'error').code;
  assert.strictEqual(await code('empty-repo'), 'empty');
  assert.strictEqual(await code('private-app'), 'not_found');
  assert.strictEqual(await code('busy-repo'), 'rate_limited');
  assert.strictEqual(await code('does-not-exist'), 'not_found');
  assert.strictEqual((await b.get('/api/repos/octo-dev/..%2Fetc/scan')).resp.status, 400);
  assert.strictEqual((await b.get('/api/repos/octo-dev/sample-app/scan?ref=../../x')).resp.status, 400);
  assert.strictEqual((await b.get('/api/repos/../sample-app/scan')).resp.status, 404, 'dot segments never reach the scan route');
  assert.strictEqual((await b.get('/api/repos/%2E%2E/sample-app/scan')).resp.status, 404, 'encoded dot segments are normalised away');
  assert.strictEqual((await b.get('/api/repos/%E0%A4%A/sample-app/scan')).resp.status, 400);
});

test('rejects callbacks with a bad state, replayed codes and cancelled logins', async () => {
  const b = new Browser(app.base);
  const start = await b.get('/auth/github/login');
  const atGitHub = await b.get(start.location);
  const forged = atGitHub.location.replace(/state=[^&]+/, 'state=forged');
  assert.strictEqual((await b.get(forged)).location, '/?github_error=failed');
  // pending login is single-use, so the genuine callback now fails too
  assert.strictEqual((await b.get(atGitHub.location)).location, '/?github_error=failed');

  gh.state.denyNext = true;
  const b2 = new Browser(app.base);
  assert.strictEqual((await b2.signIn()).location, '/?github_error=cancelled');

  const b3 = new Browser(app.base); // callback without having started a login here
  assert.strictEqual((await b3.get(`/auth/github/callback?code=code-123&state=x`)).location, '/?github_error=failed');
});

test('API requires a session; logout is same-origin only and revokes the token', async () => {
  const anon = new Browser(app.base);
  assert.strictEqual((await anon.get('/api/repos')).resp.status, 401);

  const b = new Browser(app.base);
  await b.signIn();
  const cross = await b.get('/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.strictEqual(cross.resp.status, 403);
  assert.strictEqual((await b.get('/api/repos')).resp.status, 200);

  const out = await b.get('/auth/logout', { method: 'POST', headers: { origin: app.base } });
  assert.strictEqual(out.resp.status, 200);
  assert.strictEqual((await b.get('/api/repos')).resp.status, 401);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(gh.state.revoked.includes(gh.TOKEN));
});

test('never sends write requests to GitHub', () => {
  assert.deepStrictEqual(gh.state.writes, []);
  const apiCalls = gh.state.requests.filter(r => r.path.startsWith('/repos/') || r.path.startsWith('/user'));
  assert.ok(apiCalls.length > 0 && apiCalls.every(r => r.method === 'GET'));
});

test('APP_URL typos are normalised instead of breaking the site', () => {
  const { normalizeAppUrl } = require('../server/config');
  assert.strictEqual(normalizeAppUrl('traceon-production.up.railway.app', 3000), 'https://traceon-production.up.railway.app');
  assert.strictEqual(normalizeAppUrl(' "https://x.up.railway.app/" ', 3000), 'https://x.up.railway.app');
  assert.strictEqual(normalizeAppUrl('localhost:3000', 3000), 'http://localhost:3000');
  assert.strictEqual(normalizeAppUrl('', 8080), 'http://localhost:8080');
  const cfg = loadConfig({ APP_URL: 'traceon-production.up.railway.app' });
  assert.strictEqual(cfg.github.callbackUrl, 'https://traceon-production.up.railway.app/auth/github/callback');
  assert.strictEqual(cfg.secureCookies, true);
});

test('without GitHub credentials the login reports "not configured"', async () => {
  const bare = await startTraceon(gh, { GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
  try {
    const b = new Browser(bare.base);
    assert.strictEqual((await b.get('/auth/github/login')).location, '/?github_error=not_configured');
    assert.strictEqual((await b.get('/api/session')).json().githubConfigured, false);
  } finally { await bare.close(); }
});
