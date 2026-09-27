# Traceon

**Understand your codebase before you change it.**

> **Also in this repository:** [Solana OS](solana-os/README.md), an all-in-one gateway to the Solana ecosystem (Next.js; deploy on Vercel with Root Directory `solana-os`).

Traceon connects to your GitHub repositories and turns them into a clear picture
of the project: how it is structured, where the risks are, which code is untested,
what a change will affect, and whether it is ready to release. Everything is
based on the real repository, and access is read-only.

**Live app:** https://traceon-production.up.railway.app

## What Traceon does

| Page | What you get |
|---|---|
| **Overview** | Health score, issues by severity, recommended actions, project stats and module test reach |
| **Project Map** | Modules and how they depend on each other, built from the real import graph |
| **Onboarding** | Project overview, architecture, important files, setup commands and a first-day guide |
| **Maintenance** | Vulnerable dependencies, missing lockfiles, undocumented environment variables, Docker and CI gaps |
| **Testing** | Which source files your tests actually reach, per module, and which API routes have no tests |
| **Generate Test** | Test stubs built from each file's real exports, in your test framework and folder layout |
| **Change Impact** | Everything that depends on a module, the endpoints affected and the tests to run |
| **Release** | A readiness check across tests, CI, configuration, dependencies and deployment |
| **Reports** | Health, release and maintenance reports to share with your team |

## How it works

1. **Continue with GitHub:** sign in on GitHub's own page. There is no token to create or paste.
2. **Choose repositories:** pick exactly which repositories Traceon may read.
3. **Analyze:** Traceon downloads a read-only snapshot of the branch and analyses it on the server.

## Security

- **Read-only.** Traceon never commits, pushes, opens pull requests or changes settings.
- **No tokens in the browser.** GitHub credentials stay on the Traceon server; the browser only holds a secure session cookie.
- **Secrets untouched.** Real `.env` files are never read; only variable names from templates such as `.env.example` are checked.
- **You stay in control.** Signing out revokes Traceon's GitHub token immediately.

## Run it locally

Requires Node.js 22 or newer. There are no dependencies to install.

```bash
git clone https://github.com/Kennyvincss/Traceon.git
cd Traceon
npm start
# open http://localhost:3000
```

To enable **Continue with GitHub**, register a GitHub App and set
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_APP_SLUG` in a `.env` file
(copy `.env.example`). Step-by-step instructions:
[docs/GITHUB_AUTH_SETUP.md](docs/GITHUB_AUTH_SETUP.md).

## Deploy

Traceon runs on any Node.js host (it is deployed on Railway). Set the same
variables as in `.env` on the host, with `APP_URL` set to the public `https://`
address, and add that address's `/auth/github/callback` as the GitHub App's
callback URL.

## Project structure

| Path | What it is |
|---|---|
| `traceon.html` | The Traceon UI (landing page and app). It never talks to GitHub directly and never handles tokens. |
| `server/index.js` | HTTP server: serves the UI, runs the GitHub sign-in flow, holds sessions, exposes `/api/*` |
| `server/github.js` | Read-only GitHub client, token exchange and refresh |
| `server/scanner.js` | Downloads a repository snapshot and streams scan progress to the browser |
| `server/analyze.js` | Static analysis → Traceon Project Model (modules, import graph, routes, tests, env vars, Docker, CI…) |
| `server/tar.js` | Streaming reader for GitHub tarballs |
| `public/` | Favicon and home-screen icons |
| `docs/` | GitHub sign-in setup guide |
| `test/` | Automated tests, including a local GitHub stand-in |
| `bob-sessions/` | Screenshots of the IBM Bob sessions used to build Traceon |

## Built with IBM Bob

Traceon was built with the help of IBM Bob. Screenshots of the sessions, from
planning the architecture to reviewing the finished code, are in
[bob-sessions/](bob-sessions/), each with a short description.

## Tests

```bash
npm test            # server, sign-in flow and analysis (no dependencies)
npm run test:e2e    # full browser journey; needs Playwright (npm i -g playwright)
```

Both run against a local GitHub stand-in (`test/helpers/mock-github.js`), so no
real GitHub account or network access is needed.
