'use strict';
// Traceon server configuration.
// All GitHub credentials are read from the environment (or a local .env file)
// and never leave the server.

const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function loadConfig(env = process.env) {
  if (env === process.env) loadDotEnv(path.join(__dirname, '..', '.env'));

  const port = parseInt(env.PORT || '3000', 10);
  const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const mode = (env.GITHUB_AUTH_MODE || 'app').toLowerCase();

  const cfg = {
    port,
    appUrl,
    secureCookies: appUrl.startsWith('https://'),
    github: {
      // 'app'   = GitHub App with user authorization (recommended: fine-grained, read-only)
      // 'oauth' = classic GitHub OAuth App (scopes are coarse; see docs/GITHUB_AUTH_SETUP.md)
      mode: mode === 'oauth' ? 'oauth' : 'app',
      clientId: env.GITHUB_CLIENT_ID || '',
      clientSecret: env.GITHUB_CLIENT_SECRET || '',
      appSlug: env.GITHUB_APP_SLUG || '',
      // Only used in 'oauth' mode. Default is read-only public access.
      oauthScopes: env.GITHUB_OAUTH_SCOPES || 'read:user',
      callbackUrl: `${appUrl}/auth/github/callback`,
      apiBase: env.GITHUB_API_BASE || 'https://api.github.com',
      webBase: env.GITHUB_WEB_BASE || 'https://github.com',
    },
    sessionTtlMs: parseInt(env.SESSION_TTL_HOURS || '8', 10) * 3600 * 1000,
    scan: {
      maxArchiveBytes: parseInt(env.SCAN_MAX_ARCHIVE_MB || '80', 10) * 1024 * 1024,
      maxFileBytes: 256 * 1024,
      maxFilesAnalysed: parseInt(env.SCAN_MAX_FILES || '4000', 10),
    },
  };
  cfg.githubConfigured = !!(cfg.github.clientId && cfg.github.clientSecret);
  return cfg;
}

module.exports = { loadConfig };
