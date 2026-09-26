'use strict';
// Traceon backend: serves the Traceon UI and brokers GitHub access.
//
//   GET  /                          Traceon UI (traceon.html)
//   GET  /auth/github/login         Start "Continue with GitHub" (redirects to GitHub)
//   GET  /auth/github/callback      GitHub redirects here; code is exchanged server-side
//   POST /auth/logout               Sign out (revokes the token, clears the session)
//   GET  /api/session               Safe auth status: { authenticated, user, ... }
//   GET  /api/repos                 Repositories the user authorized Traceon to read
//   GET  /api/repos/:owner/:repo/scan?ref=   Streamed (NDJSON) read-only repository scan
//
// The GitHub client secret and access tokens never reach the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { SessionStore } = require('./sessions');
const gh = require('./github');
const { scanRepository } = require('./scanner');

const HTML_PATH = path.join(__dirname, '..', 'traceon.html');
const SID = 'traceon_sid';
const OAUTH = 'traceon_oauth';
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,255}$/;

const HTTP_STATUS = { not_authenticated: 401, forbidden: 403, not_found: 404, empty: 422, rate_limited: 429, unavailable: 502 };

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}

function cookie(cfg, name, value, { maxAge, path: p = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=Lax`;
  if (cfg.secureCookies) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  return c;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function baseHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }));
  res.end(JSON.stringify(body));
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, baseHeaders({ Location: location, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) }));
  res.end();
}

function createApp({ cfg = loadConfig(), fetchImpl = fetch, store } = {}) {
  const sessions = store || new SessionStore({ ttlMs: cfg.sessionTtlMs });
  const installUrl = cfg.github.mode === 'app' && cfg.github.appSlug
    ? `${cfg.github.webBase}/apps/${cfg.github.appSlug}/installations/new` : null;
  const log = (...a) => { if (process.env.NODE_ENV !== 'test') console.log('[traceon]', ...a); };

  function currentSession(req) {
    const sid = parseCookies(req.headers.cookie)[SID];
    const s = sessions.get(sid);
    return s ? { sid, session: s } : { sid: null, session: null };
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return req.headers['x-requested-with'] === 'traceon';
    return origin === cfg.appUrl || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://traceon.local');
    const p = url.pathname;

    // ---- UI ----
    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/traceon.html')) {
      const html = fs.readFileSync(HTML_PATH);
      res.writeHead(200, baseHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': [
          "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
          "img-src 'self' data: https://avatars.githubusercontent.com", "connect-src 'self'",
          "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
        ].join('; '),
      }));
      return res.end(html);
    }

    // ---- OAuth: start ----
    if (req.method === 'GET' && p === '/auth/github/login') {
      if (!cfg.githubConfigured) return redirect(res, '/?github_error=not_configured');
      const state = crypto.randomBytes(24).toString('base64url');
      const { verifier, challenge } = gh.pkcePair();
      const pendingId = sessions.createPending({ state, verifier });
      return redirect(res, gh.authorizeUrl(cfg, state, challenge), [
        cookie(cfg, OAUTH, pendingId, { maxAge: 600, path: '/auth/github' }),
      ]);
    }

    // ---- OAuth: callback ----
    if (req.method === 'GET' && p === '/auth/github/callback') {
      const clearPending = cookie(cfg, OAUTH, '', { maxAge: 0, path: '/auth/github' });
      const pending = sessions.takePending(parseCookies(req.headers.cookie)[OAUTH]);
      const err = url.searchParams.get('error');
      if (err) return redirect(res, `/?github_error=${err === 'access_denied' ? 'cancelled' : 'failed'}`, [clearPending]);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!pending || !code || !state || !safeEqual(state, pending.state)) {
        return redirect(res, '/?github_error=failed', [clearPending]);
      }
      try {
        const tokens = await gh.exchangeCode(cfg, code, pending.verifier, fetchImpl);
        const temp = { github: tokens };
        const user = gh.sanitizeUser(await new gh.GitHubClient(cfg, temp, fetchImpl).user());
        const prev = currentSession(req);
        if (prev.sid) sessions.destroy(prev.sid); // rotate session id on login
        const sid = sessions.create({ github: temp.github, user });
        log(`signed in @${user.login}`);
        return redirect(res, '/?github=connected', [
          clearPending,
          cookie(cfg, SID, sid, { maxAge: cfg.sessionTtlMs / 1000 }),
        ]);
      } catch (e) {
        log('oauth callback failed:', e.code || 'error');
        return redirect(res, `/?github_error=${e.code === 'rate_limited' ? 'rate_limited' : 'failed'}`, [clearPending]);
      }
    }

    // ---- Sign out ----
    if (p === '/auth/logout') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
      const { sid, session } = currentSession(req);
      if (session) {
        sessions.destroy(sid);
        gh.revokeToken(cfg, session.github.accessToken, fetchImpl);
      }
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(cfg, SID, '', { maxAge: 0 }) });
    }

    // ---- Session status (safe fields only) ----
    if (req.method === 'GET' && p === '/api/session') {
      const { session } = currentSession(req);
      return sendJson(res, 200, {
        backend: true,
        githubConfigured: cfg.githubConfigured,
        mode: cfg.github.mode,
        authenticated: !!session,
        user: session ? session.user : null,
        installUrl,
      });
    }

    // ---- Everything below requires a signed-in user ----
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      const { sid, session } = currentSession(req);
      if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
      const client = new gh.GitHubClient(cfg, session, fetchImpl);

      const fail = e => {
        const code = e && HTTP_STATUS[e.code] ? e.code : 'unavailable';
        if (code === 'not_authenticated') sessions.destroy(sid);
        log(`${p} → ${code}`);
        return sendJson(res, HTTP_STATUS[code], { error: code });
      };

      if (p === '/api/repos') {
        try {
          const { repositories, installations } = await client.listRepositories();
          return sendJson(res, 200, { repositories, installations, mode: cfg.github.mode, installUrl });
        } catch (e) { return fail(e); }
      }

      const m = p.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/scan$/);
      if (m) {
        let owner, repo;
        try { owner = decodeURIComponent(m[1]); repo = decodeURIComponent(m[2]); } catch { return sendJson(res, 400, { error: 'bad_request' }); }
        const ref = url.searchParams.get('ref') || '';
        const validName = n => NAME_RE.test(n) && !/^\.\.?$/.test(n);
        if (!validName(owner) || !validName(repo) || (ref && (!REF_RE.test(ref) || ref.includes('..')))) {
          return sendJson(res, 400, { error: 'bad_request' });
        }
        // One scan at a time per session keeps memory use bounded.
        if (session.scanning) return sendJson(res, 429, { error: 'busy' });
        session.scanning = true;
        res.writeHead(200, baseHeaders({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }));
        const emit = ev => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
        try {
          const model = await scanRepository(client, cfg, owner, repo, ref, emit);
          emit({ type: 'result', model });
          log(`scanned ${owner}/${repo}: ${model.totalFiles} files`);
        } catch (e) {
          const code = e && HTTP_STATUS[e.code] ? e.code : 'unavailable';
          if (code === 'not_authenticated') sessions.destroy(sid);
          log(`scan ${owner}/${repo} → ${code}`, e && !e.code ? e.message : '');
          emit({ type: 'error', code });
        } finally {
          session.scanning = false;
        }
        return res.end();
      }
      return sendJson(res, 404, { error: 'not_found' });
    }

    res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Not found');
  }

  return (req, res) => {
    handle(req, res).catch(e => {
      log('unhandled error:', e && e.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'unavailable' });
      else res.end();
    });
  };
}

if (require.main === module) {
  const cfg = loadConfig();
  http.createServer(createApp({ cfg })).listen(cfg.port, () => {
    console.log(`[traceon] listening on ${cfg.appUrl}`);
    if (!cfg.githubConfigured) {
      console.log('[traceon] GitHub sign-in is not configured: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (see docs/GITHUB_AUTH_SETUP.md).');
      console.log('[traceon] The Demo Project works without it.');
    } else {
      console.log(`[traceon] GitHub ${cfg.github.mode === 'app' ? 'App' : 'OAuth App'} sign-in enabled; callback URL: ${cfg.github.callbackUrl}`);
    }
  });
}

module.exports = { createApp, parseCookies };
