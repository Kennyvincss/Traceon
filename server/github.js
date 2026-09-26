'use strict';
// GitHub access for Traceon.
//
// Security properties:
//   * Repository data is only ever *read*: every repository call goes through
//     `get()`, which issues HTTP GET. Traceon never commits, pushes, opens pull
//     requests, deletes files or changes settings.
//   * The client secret and user tokens stay on the server.
//   * Errors are mapped to short codes; raw GitHub responses are not forwarded.

const crypto = require('crypto');

const USER_AGENT = 'Traceon';

class GitHubError extends Error {
  // code: not_authenticated | forbidden | not_found | empty | rate_limited | unavailable
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl(cfg, state, codeChallenge) {
  const params = new URLSearchParams({
    client_id: cfg.github.clientId,
    redirect_uri: cfg.github.callbackUrl,
    state,
    allow_signup: 'true',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  // GitHub Apps get their (read-only) permissions from the app settings, not scopes.
  if (cfg.github.mode === 'oauth') params.set('scope', cfg.github.oauthScopes);
  return `${cfg.github.webBase}/login/oauth/authorize?${params}`;
}

async function tokenRequest(cfg, body, fetchImpl = fetch) {
  let resp;
  try {
    resp = await fetchImpl(`${cfg.github.webBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ client_id: cfg.github.clientId, client_secret: cfg.github.clientSecret, ...body }),
    });
  } catch {
    throw new GitHubError('unavailable', 0);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error || !data.access_token) throw new GitHubError('not_authenticated', resp.status);
  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
    scopes: data.scope || '',
  };
}

function exchangeCode(cfg, code, codeVerifier, fetchImpl) {
  return tokenRequest(cfg, { code, redirect_uri: cfg.github.callbackUrl, code_verifier: codeVerifier }, fetchImpl);
}

function refreshToken(cfg, refresh, fetchImpl) {
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl);
}

// Revoke the user's token on sign-out (best effort). This removes Traceon's
// authorization for this token only; it does not touch any repository.
async function revokeToken(cfg, accessToken, fetchImpl = fetch) {
  try {
    const basic = Buffer.from(`${cfg.github.clientId}:${cfg.github.clientSecret}`).toString('base64');
    await fetchImpl(`${cfg.github.apiBase}/applications/${cfg.github.clientId}/token`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
    });
  } catch { /* ignore */ }
}

async function classifyError(resp) {
  const s = resp.status;
  if (s === 429) return new GitHubError('rate_limited', s);
  if (s === 403) {
    const remaining = resp.headers.get('x-ratelimit-remaining');
    const text = await resp.text().catch(() => '');
    if (remaining === '0' || /rate limit/i.test(text)) return new GitHubError('rate_limited', s);
    return new GitHubError('forbidden', s);
  }
  if (s === 401) return new GitHubError('not_authenticated', s);
  if (s === 404) return new GitHubError('not_found', s);
  if (s === 409) return new GitHubError('empty', s); // "Git Repository is empty."
  return new GitHubError('unavailable', s);
}

// Per-session client. `session.github` holds the token set.
class GitHubClient {
  constructor(cfg, session, fetchImpl = fetch) {
    this.cfg = cfg;
    this.session = session;
    this.fetch = fetchImpl;
  }

  async token() {
    const g = this.session.github;
    if (g.expiresAt && Date.now() > g.expiresAt - 60 * 1000) await this.refresh();
    return this.session.github.accessToken;
  }

  async refresh() {
    const g = this.session.github;
    if (!g.refreshToken || (g.refreshExpiresAt && Date.now() > g.refreshExpiresAt)) {
      throw new GitHubError('not_authenticated', 401);
    }
    this.session.github = await refreshToken(this.cfg, g.refreshToken, this.fetch);
  }

  async request(path, { accept = 'application/vnd.github+json', redirect = 'follow', retried = false } = {}) {
    const url = path.startsWith('http') ? path : this.cfg.github.apiBase + path;
    let resp;
    try {
      resp = await this.fetch(url, {
        method: 'GET',
        redirect,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': USER_AGENT,
        },
      });
    } catch (e) {
      if (e instanceof GitHubError) throw e;
      throw new GitHubError('unavailable', 0);
    }
    if (resp.status === 401 && !retried && this.session.github.refreshToken) {
      await this.refresh();
      return this.request(path, { accept, redirect, retried: true });
    }
    if (resp.status >= 300 && resp.status < 400 && redirect === 'manual') return resp;
    if (!resp.ok) throw await classifyError(resp);
    return resp;
  }

  async get(path) {
    const resp = await this.request(path);
    return resp.json();
  }

  async getText(path) {
    const resp = await this.request(path, { accept: 'application/vnd.github.raw+json' });
    return resp.text();
  }

  user() {
    return this.get('/user');
  }

  async paginate(path, pick, maxPages = 10) {
    const out = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.get(`${path}${sep}per_page=100&page=${page}`);
      const items = pick ? pick(data) : data;
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  // Repositories the signed-in user has authorized Traceon to read.
  async listRepositories() {
    if (this.cfg.github.mode === 'app') {
      const installations = await this.paginate('/user/installations', d => d.installations || [], 3);
      const seen = new Map();
      for (const inst of installations) {
        const repos = await this.paginate(`/user/installations/${inst.id}/repositories`, d => d.repositories || []);
        for (const r of repos) seen.set(r.id, r);
      }
      return { repositories: [...seen.values()].map(sanitizeRepo), installations: installations.length };
    }
    const repos = await this.paginate('/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member', null, 5);
    return { repositories: repos.map(sanitizeRepo), installations: null };
  }

  repo(owner, name) {
    return this.get(`/repos/${owner}/${name}`);
  }

  commit(owner, name, ref) {
    return this.get(`/repos/${owner}/${name}/commits/${encodeRef(ref)}`);
  }

  tree(owner, name, sha) {
    return this.get(`/repos/${owner}/${name}/git/trees/${sha}?recursive=1`);
  }

  file(owner, name, path, sha) {
    return this.getText(`/repos/${owner}/${name}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
  }

  // Returns a Response whose body is the gzipped tarball of the repository at `sha`.
  async tarball(owner, name, sha) {
    const first = await this.request(`/repos/${owner}/${name}/tarball/${sha}`, { redirect: 'manual' });
    if (first.status < 300 || first.status >= 400) return first;
    const location = first.headers.get('location');
    const allowHttp = this.cfg.github.apiBase.startsWith('http://'); // local GitHub Enterprise / test doubles only
    if (!location || !(location.startsWith('https://') || (allowHttp && location.startsWith('http://')))) {
      throw new GitHubError('unavailable', first.status);
    }
    // The redirect target is a short-lived signed URL; the user token is not sent to it.
    let resp;
    try {
      resp = await this.fetch(location, { headers: { 'User-Agent': USER_AGENT } });
    } catch {
      throw new GitHubError('unavailable', 0);
    }
    if (!resp.ok) throw await classifyError(resp);
    return resp;
  }
}

function encodeRef(ref) {
  return String(ref).split('/').map(encodeURIComponent).join('/');
}

// Only safe, display-oriented fields are sent to the browser.
function sanitizeRepo(r) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    owner: r.owner && r.owner.login,
    owner_avatar: r.owner && r.owner.avatar_url,
    private: !!r.private,
    visibility: r.visibility || (r.private ? 'private' : 'public'),
    language: r.language || null,
    description: r.description || '',
    default_branch: r.default_branch || 'main',
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    created_at: r.created_at,
    stargazers_count: r.stargazers_count || 0,
    fork: !!r.fork,
    archived: !!r.archived,
    size: r.size || 0,
    html_url: r.html_url,
  };
}

function sanitizeUser(u) {
  return { login: u.login, name: u.name || '', avatar_url: u.avatar_url, html_url: u.html_url };
}

module.exports = {
  GitHubClient, GitHubError, pkcePair, authorizeUrl, exchangeCode, revokeToken, sanitizeRepo, sanitizeUser,
};
