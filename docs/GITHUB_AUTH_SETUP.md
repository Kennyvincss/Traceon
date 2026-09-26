# GitHub sign-in for Traceon

Traceon connects to GitHub with a standard **"Continue with GitHub"** OAuth sign-in.
Users never paste tokens, enter credentials, or connect a wallet. Everything
secret stays on the Traceon server.

```text
Browser (traceon.html)          Traceon server (server/)                 GitHub
─────────────────────           ────────────────────────                 ──────
Continue with GitHub  ──────▶  GET /auth/github/login
                                 creates state + PKCE verifier  ──────▶  /login/oauth/authorize
                                                                          user approves access
                        ◀──────────────────────────────────────────────  redirect with ?code&state
                               GET /auth/github/callback
                                 checks state (single use)
                                 exchanges code + secret + PKCE ──────▶  /login/oauth/access_token
                                 stores token in server session
                                 sets HttpOnly session cookie
Back in Traceon      ◀──────── redirect to /?github=connected
GET /api/session, /api/repos ─▶ reads GitHub with the stored token ────▶ REST API (GET only)
Analyze Repository   ────────▶ GET /api/repos/:owner/:repo/scan  ─────▶  tarball of the branch
                     ◀──────── streamed progress + Project Model
```

The browser only ever receives safe data: username, avatar URL, repository
metadata and analysis results. The GitHub access token, refresh token and
client secret are never sent to the browser, stored in browser storage or put
in a URL.

---

## 1. Choose an app type

| | **GitHub App (recommended)** | OAuth App |
|---|---|---|
| Repository access | Only repositories the user selects | Every repository the user can see |
| Permissions | Fine-grained, **read-only** (Contents + Metadata) | Coarse scopes. `repo` (needed for private repos) also allows writes |
| Tokens | Short-lived, refreshed automatically | Long-lived |
| `GITHUB_AUTH_MODE` | `app` | `oauth` |

Use a **GitHub App** unless you have a specific reason not to.

## 2a. Register a GitHub App (recommended)

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App**.
For an organization, use **Organization settings → Developer settings → GitHub Apps**.

| Field | Value |
|---|---|
| GitHub App name | `Traceon` (it must be unique on GitHub, e.g. `Traceon – Acme`) |
| Homepage URL | your `APP_URL`, e.g. `https://traceon.example.com` |
| Callback URL | `APP_URL/auth/github/callback`, e.g. `https://traceon.example.com/auth/github/callback` |
| Expire user authorization tokens | ✅ checked (Traceon refreshes them) |
| Request user authorization (OAuth) during installation | ☐ unchecked |
| Enable Device Flow | ☐ unchecked |
| Setup URL | `APP_URL/auth/github/login` (brings users straight back to their repository list after installing) |
| Redirect on update | ✅ checked |
| Webhook → Active | ☐ unchecked (Traceon does not use webhooks) |

**Repository permissions** (leave everything else at *No access*):

| Permission | Access |
|---|---|
| Contents | **Read-only** |
| Metadata | **Read-only** (mandatory) |

**Account permissions**: none.
**Where can this GitHub App be installed?**: *Any account* for a hosted
Traceon, or *Only on this account* for internal use.

After creating the app:

1. Copy the **Client ID** (starts with `Iv`) to `GITHUB_CLIENT_ID`.
2. Click **Generate a new client secret** and copy it to `GITHUB_CLIENT_SECRET`.
3. Set `GITHUB_APP_SLUG` to the app's URL name: `https://github.com/apps/<slug>`.
4. Set `GITHUB_AUTH_MODE=app`.

How users experience it:

1. They click **Continue with GitHub** and approve Traceon on GitHub.
2. If they haven't chosen any repositories yet, Traceon shows **Select repositories on GitHub**.
3. That opens the app's install page, where they pick repositories. They then return to Traceon with the list loaded.
4. They can change the selection at any time with the **Missing a repository?** link under the list.

## 2b. Or register an OAuth App

On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.

| Field | Value |
|---|---|
| Homepage URL | your `APP_URL` |
| Authorization callback URL | `APP_URL/auth/github/callback` |

Then set `GITHUB_AUTH_MODE=oauth`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

Scopes are set with `GITHUB_OAUTH_SCOPES`:

- `read:user` is the default. It gives read-only access to public repositories.
- `read:user repo` is needed for private repositories. GitHub has no read-only
  scope for private repositories, so this token *could* write. Traceon still only
  ever sends GET requests, but a GitHub App is the safer choice.

## 3. Configure and run the server

```bash
cp .env.example .env      # then fill in the values
npm start                 # Node.js 22+, no dependencies to install
```

| Variable | Required | Description |
|---|---|---|
| `APP_URL` | yes | Public URL of Traceon, without a trailing slash. It must match the callback URL registered on GitHub. |
| `PORT` | no | Port to listen on (default `3000`). |
| `GITHUB_AUTH_MODE` | no | `app` (default) or `oauth`. |
| `GITHUB_CLIENT_ID` | yes | From the app settings page. |
| `GITHUB_CLIENT_SECRET` | yes | From the app settings page. Server-side only. **Never commit it.** |
| `GITHUB_APP_SLUG` | app mode | Enables the "choose repositories" links. |
| `GITHUB_OAUTH_SCOPES` | oauth mode | Default `read:user`. |
| `SESSION_TTL_HOURS` | no | Idle session lifetime (default 8). |
| `SCAN_MAX_ARCHIVE_MB` | no | Largest repository archive to download (default 80). Larger repositories fall back to reading key files one by one. |
| `SCAN_MAX_FILES` | no | Maximum number of files analysed per scan (default 4000). |
| `GITHUB_WEB_BASE`, `GITHUB_API_BASE` | no | Only for GitHub Enterprise Server. |

In production, serve Traceon over **HTTPS**, for example behind a TLS-terminating
proxy with `APP_URL=https://…`. Session cookies are marked `Secure` automatically
when `APP_URL` uses https.

If the GitHub variables are missing, Traceon still starts. The Demo Project works,
and **Continue with GitHub** explains that sign-in has not been set up yet. It
never falls back to a fake login.

## 4. Server routes

| Route | Purpose |
|---|---|
| `GET /` | Traceon UI |
| `GET /auth/github/login` | Starts sign-in: creates `state` + PKCE, redirects to GitHub |
| `GET /auth/github/callback` | GitHub redirect target: validates `state`, exchanges the code, creates the session |
| `POST /auth/logout` | Signs out: revokes the token on GitHub and clears the session (same-origin only) |
| `GET /api/session` | `{ authenticated, user: { login, name, avatar_url }, githubConfigured, mode, installUrl }` |
| `GET /api/repos` | The user's authorized repositories (safe fields only) |
| `GET /api/repos/:owner/:repo/scan?ref=` | Read-only scan, streamed as newline-delimited JSON (`stage`, `counts`, then `result` or `error`) |

Error codes returned to the UI: `cancelled`, `failed`, `not_authenticated`,
`forbidden` / `not_found` (no permission), `empty`, `rate_limited`, `unavailable`.
Raw GitHub responses, tokens and stack traces are never returned.

## 5. What Traceon reads

For the selected branch, Traceon downloads one read-only snapshot and analyses:

- folder structure, source and test files
- dependency manifests and lockfiles
- test configuration
- README and docs
- API route definitions
- Dockerfiles and CI/CD workflows
- `.env.example`-style templates (variable names only)

Actual `.env` files are **not** read. If one is committed, Traceon only reports
that it exists. Source code is analysed on the server; the browser receives
derived facts (paths, import graph, routes, exported names, counts), not the
file contents.

Traceon never commits, pushes, opens pull requests, deletes files or changes
repository settings. The server has no code path that sends a write request to a
repository.

## 6. Security notes and limits

- **Sessions:** kept in server memory, keyed by a random 256-bit id held in an `HttpOnly; SameSite=Lax` cookie. The id is rotated on every sign-in.
- **Session storage is single-instance:** a restart signs everyone out, and multiple instances need a shared store such as Redis, with encryption at rest. `server/sessions.js` is the only file to change.
- **OAuth `state`:** random, single use, expires after 10 minutes and is compared in constant time. PKCE (S256) is also used.
- **Sign-out:** revokes the token on GitHub.
- **Response headers:** a Content Security Policy that only lets the page talk to its own server, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.
- **Analysis is static:** Traceon does not execute repository code. "Files reached by tests" is derived from the import graph; it is not line coverage.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| GitHub shows "The redirect_uri is not associated with this application" | `APP_URL` + `/auth/github/callback` must exactly match the callback URL in the app settings. |
| "No repositories available yet" | GitHub App mode: the user has not selected any repositories yet. Use **Select repositories on GitHub**. |
| "We could not connect to GitHub" | Check the client ID and secret, and that the server can reach github.com. |
| "GitHub temporarily limited requests" | GitHub rate limit reached. Wait and try again. |
| "Traceon does not have permission to access this repository" | The repository is not included in the app installation, or the user lost access. |
