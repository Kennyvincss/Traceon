# Traceon

Traceon helps developers understand a codebase before they change it. It maps the
architecture, finds maintenance issues and testing gaps, shows the impact of a
change, prepares releases, and helps new team members onboard.

## Quick start

```bash
npm start            # Node.js 22+ — no dependencies to install
# open http://localhost:3000
```

- **Try Demo Project** works immediately. It loads *ShopCore API*, a demo project
  with simulated data, clearly labelled **DEMO PROJECT** / **SIMULATED**.
- **Continue with GitHub** signs in with GitHub (standard OAuth) and analyses your
  real repositories, read-only. These are labelled **LIVE PROJECT · GITHUB REPOSITORY**.
  To enable it, register a GitHub App and set three environment variables; see
  [docs/GITHUB_AUTH_SETUP.md](docs/GITHUB_AUTH_SETUP.md).

## How it fits together

| Path | What it is |
|---|---|
| `traceon.html` | The Traceon UI (single page). It never talks to GitHub directly and never handles tokens. |
| `server/index.js` | HTTP server: serves the UI, runs the GitHub OAuth flow, holds sessions, exposes `/api/*` |
| `server/github.js` | Read-only GitHub client, token exchange and refresh |
| `server/scanner.js` | Downloads a repository snapshot and streams scan progress |
| `server/analyze.js` | Static analysis → Traceon Project Model (modules, import graph, routes, tests, env vars, Docker, CI…) |
| `server/tar.js` | Streaming reader for GitHub tarballs |
| `test/` | Tests, including a local GitHub stand-in for the OAuth + scan flow |

After a GitHub repository is scanned, every page uses that repository's data:
Overview, Project Map, Onboarding, Maintenance, Testing, Generate Test, Change
Impact, Release and Reports.

## Tests

```bash
npm test            # server, OAuth flow, analysis (no dependencies)
npm run test:e2e    # full browser journey; needs Playwright (npm i -g playwright)
```

Both run against a local GitHub stand-in (`test/helpers/mock-github.js`), so no
real GitHub account or network access is needed.
