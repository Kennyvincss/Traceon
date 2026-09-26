'use strict';
// Static analysis of a repository snapshot → Traceon Project Model.
// Pure functions: input is the list of file paths plus the text contents of the
// files Traceon chose to read. Nothing here talks to GitHub.

const posix = require('path').posix;

// ------------------------------------------------------------------
// File classification
// ------------------------------------------------------------------
const IGNORED_DIR = /(^|\/)(node_modules|vendor|dist|build|out|target|\.next|\.nuxt|\.svelte-kit|coverage|__pycache__|\.venv|venv|env|\.git|bower_components|third_party|\.yarn|\.pnpm-store|Pods)\//;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|kts|cs|rb|php|swift|scala|c|cc|cpp|h|hpp|m|dart|ex|exs)$/i;
const TEST_PATH = [
  /\.(test|spec)\.[a-z]+$/i,
  /(^|\/)(__tests__|tests?|spec|specs|e2e|cypress|integration-tests)\//i,
  /_test\.(go|py)$/,
  /(^|\/)test_[^/]+\.py$/,
  /Tests?\.(java|kt|cs)$/,
  /_spec\.rb$/,
];
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i;
const LOCKFILES = {
  'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'yarn.lock': 'npm', 'pnpm-lock.yaml': 'npm', 'bun.lockb': 'npm', 'bun.lock': 'npm',
  'poetry.lock': 'python', 'Pipfile.lock': 'python', 'uv.lock': 'python', 'pdm.lock': 'python',
  'go.sum': 'go', 'Cargo.lock': 'rust', 'Gemfile.lock': 'ruby', 'composer.lock': 'php',
  'packages.lock.json': 'dotnet', 'gradle.lockfile': 'java',
};
const CI_PATH = /(^\.github\/workflows\/[^/]+\.ya?ml$)|(^\.gitlab-ci\.ya?ml$)|(^\.circleci\/config\.ya?ml$)|(^Jenkinsfile$)|(^azure-pipelines\.ya?ml$)|(^\.travis\.ya?ml$)|(^bitbucket-pipelines\.ya?ml$)/;
const DEPLOY_PATH = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Procfile|vercel\.json|netlify\.toml|fly\.toml|render\.ya?ml|app\.ya?ml|serverless\.ya?ml|Chart\.yaml|[^/]+\.tf)$|(^|\/)(k8s|kubernetes|helm|deploy|deployment|infra)\//i;
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$|(^|\/)(example|sample)\.env$/i;
const TEST_CONFIG = /(^|\/)(jest\.config\.[a-z]+|vitest\.config\.[a-z]+|vitest\.workspace\.[a-z]+|karma\.conf\.[a-z]+|\.mocharc(\.[a-z]+)?|playwright\.config\.[a-z]+|cypress\.config\.[a-z]+|cypress\.json|pytest\.ini|conftest\.py|tox\.ini|noxfile\.py|phpunit\.xml(\.dist)?|\.rspec|jasmine\.json)$/;
const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj)$/;

function isIgnored(p) { return IGNORED_DIR.test(p) || /\.min\.(js|css)$/.test(p); }
function isSource(p) { return SOURCE_EXT.test(p) && !isIgnored(p) && !/\.d\.ts$/.test(p); }
function isTest(p) { return isSource(p) && TEST_PATH.some(r => r.test(p)); }
function baseName(p) { return p.split('/').pop(); }

function classify(paths) {
  const files = paths.filter(p => !/(^|\/)\.git\//.test(p));
  const sourceAll = files.filter(isSource);
  const testFiles = sourceAll.filter(isTest);
  const testSet = new Set(testFiles);
  return {
    allFiles: files,
    sourceFiles: sourceAll.filter(f => !testSet.has(f)),
    testFiles,
    configFiles: files.filter(f => !isIgnored(f) && (/\.(json|ya?ml|toml|ini|cfg|conf)$/i.test(f) || /(^|\/)\.[a-z]+rc(\.[a-z]+)?$/i.test(f) || ENV_TEMPLATE.test(f) || /\.config\.[a-z]+$/.test(f))),
    docFiles: files.filter(f => !isIgnored(f) && DOC_EXT.test(f)),
    deployFiles: files.filter(f => !isIgnored(f) && (DEPLOY_PATH.test(f) || CI_PATH.test(f))),
    ciFiles: files.filter(f => CI_PATH.test(f)),
    lockfiles: files.filter(f => !isIgnored(f) && LOCKFILES[baseName(f)]),
    testConfigFiles: files.filter(f => !isIgnored(f) && TEST_CONFIG.test(f)),
    envTemplates: files.filter(f => !isIgnored(f) && ENV_TEMPLATE.test(f)),
    manifestFiles: files.filter(f => !isIgnored(f) && MANIFEST.test(f)),
  };
}

// Which files' contents the scanner should keep for analysis.
function wantContent(path, size, maxFileBytes) {
  if (isIgnored(path) || size > maxFileBytes) return false;
  const b = baseName(path);
  if (isSource(path)) return true;
  if (MANIFEST.test(path) || TEST_CONFIG.test(path) || ENV_TEMPLATE.test(path) || CI_PATH.test(path)) return true;
  if (/^Dockerfile|^docker-compose|^compose\.ya?ml$|^Procfile$/.test(b)) return true;
  if (DOC_EXT.test(path) && size <= 128 * 1024) return true;
  return false;
}

// ------------------------------------------------------------------
// Manifests & dependencies
// ------------------------------------------------------------------
function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

function tomlSection(text, header) {
  const re = new RegExp(`^\\[${header.replace(/[.[\]]/g, m => '\\' + m)}\\]\\s*$`, 'm');
  const m = re.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function tomlKeys(section) {
  const out = {};
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (m && m[1] !== 'python') out[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/^\{.*version\s*=\s*"([^"]+)".*\}$/, '$1');
  }
  return out;
}

function parseRequirements(text) {
  const deps = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = line.match(/^([A-Za-z0-9_.\-[\]]+)\s*(.*)$/);
    if (m) deps[m[1].replace(/\[.*\]/, '').toLowerCase()] = m[2].trim() || '*';
  }
  return deps;
}

function parseManifests(files, contents) {
  const manifests = [];
  for (const f of files.manifestFiles) {
    const text = contents.get(f);
    if (text == null) continue;
    const b = baseName(f);
    let entry = null;
    if (b === 'package.json') {
      const pkg = safeJson(text);
      if (pkg) entry = { ecosystem: 'npm', deps: pkg.dependencies || {}, devDeps: { ...(pkg.devDependencies || {}) }, pkg };
    } else if (/^requirements.*\.txt$/.test(b)) {
      const deps = parseRequirements(text);
      entry = /dev|test/.test(b) ? { ecosystem: 'python', deps: {}, devDeps: deps } : { ecosystem: 'python', deps, devDeps: {} };
    } else if (b === 'pyproject.toml') {
      const deps = {};
      const arr = text.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
      if (arr) for (const m of arr[1].matchAll(/["']([A-Za-z0-9_.-]+)\s*([^"']*)["']/g)) deps[m[1].toLowerCase()] = m[2] || '*';
      Object.assign(deps, tomlKeys(tomlSection(text, 'tool.poetry.dependencies')));
      const dev = { ...tomlKeys(tomlSection(text, 'tool.poetry.dev-dependencies')), ...tomlKeys(tomlSection(text, 'tool.poetry.group.dev.dependencies')) };
      entry = { ecosystem: 'python', deps, devDeps: dev };
    } else if (b === 'Pipfile') {
      entry = { ecosystem: 'python', deps: tomlKeys(tomlSection(text, 'packages')), devDeps: tomlKeys(tomlSection(text, 'dev-packages')) };
    } else if (b === 'go.mod') {
      const deps = {};
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/gm)) deps[m[1]] = m[2];
      const mod = text.match(/^module\s+(\S+)/m);
      entry = { ecosystem: 'go', deps, devDeps: {}, goModule: mod ? mod[1] : null };
    } else if (b === 'Cargo.toml') {
      entry = { ecosystem: 'rust', deps: tomlKeys(tomlSection(text, 'dependencies')), devDeps: tomlKeys(tomlSection(text, 'dev-dependencies')) };
    } else if (b === 'Gemfile') {
      const deps = {};
      for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) deps[m[1]] = m[2] || '*';
      entry = { ecosystem: 'ruby', deps, devDeps: {} };
    } else if (b === 'composer.json') {
      const c = safeJson(text);
      if (c) entry = { ecosystem: 'php', deps: c.require || {}, devDeps: c['require-dev'] || {} };
    } else if (b === 'pom.xml') {
      const deps = {};
      for (const m of text.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>(?:[\s\S]*?<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g)) deps[`${m[1]}:${m[2]}`] = m[3] || '*';
      entry = { ecosystem: 'java', deps, devDeps: {} };
    } else if (/^build\.gradle/.test(b)) {
      const deps = {};
      for (const m of text.matchAll(/(?:implementation|api|compile|runtimeOnly)\s*\(?\s*['"]([^:'"]+:[^:'"]+)(?::([^'"]+))?['"]/g)) deps[m[1]] = m[2] || '*';
      entry = { ecosystem: 'java', deps, devDeps: {} };
    } else if (/\.csproj$/.test(b)) {
      const deps = {};
      for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) deps[m[1]] = m[2] || '*';
      entry = { ecosystem: 'dotnet', deps, devDeps: {} };
    }
    if (entry) manifests.push({ path: f, ...entry });
  }
  manifests.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  return manifests;
}

function sanitizePackageJson(pkg) {
  if (!pkg) return null;
  return {
    name: pkg.name, version: pkg.version, description: pkg.description, private: pkg.private,
    main: pkg.main, module: pkg.module, bin: pkg.bin, type: pkg.type,
    scripts: pkg.scripts || {}, engines: pkg.engines || {}, workspaces: pkg.workspaces || null,
    dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {},
    jest: pkg.jest ? true : undefined,
  };
}

// ------------------------------------------------------------------
// Frameworks & test tooling
// ------------------------------------------------------------------
const FRAMEWORK_RULES = [
  ['Next.js', d => d.next], ['Nuxt', d => d.nuxt], ['SvelteKit', d => d['@sveltejs/kit']], ['Remix', d => Object.keys(d).some(k => k.startsWith('@remix-run/'))],
  ['Astro', d => d.astro], ['NestJS', d => d['@nestjs/core']], ['Django', d => d.django], ['Ruby on Rails', d => d.rails],
  ['Laravel', d => d['laravel/framework']], ['Spring Boot', d => Object.keys(d).some(k => k.includes('spring-boot'))],
  ['FastAPI', d => d.fastapi], ['Flask', d => d.flask], ['Express.js', d => d.express], ['Fastify', d => d.fastify],
  ['Koa', d => d.koa], ['Hono', d => d.hono], ['Gin', d => d['github.com/gin-gonic/gin']], ['Echo', d => d['github.com/labstack/echo/v4'] || d['github.com/labstack/echo']],
  ['Fiber', d => Object.keys(d).some(k => k.startsWith('github.com/gofiber/fiber'))], ['chi', d => Object.keys(d).some(k => k.startsWith('github.com/go-chi/chi'))],
  ['Actix Web', d => d['actix-web']], ['Axum', d => d.axum], ['Rocket', d => d.rocket], ['Symfony', d => Object.keys(d).some(k => k.startsWith('symfony/'))],
  ['ASP.NET Core', d => Object.keys(d).some(k => k.startsWith('Microsoft.AspNetCore'))],
  ['Electron', d => d.electron], ['React Native', d => d['react-native']], ['Angular', d => d['@angular/core']],
  ['React', d => d.react], ['Vue.js', d => d.vue], ['Svelte', d => d.svelte], ['Streamlit', d => d.streamlit],
  ['PyTorch', d => d.torch], ['TensorFlow', d => d.tensorflow], ['Vite', d => d.vite], ['Tokio', d => d.tokio],
];

function detectFrameworks(allDeps, files) {
  const out = FRAMEWORK_RULES.filter(([, test]) => test(allDeps)).map(([n]) => n);
  if (!out.includes('Django') && files.allFiles.some(f => baseName(f) === 'manage.py')) out.push('Django');
  if (!out.includes('Angular') && files.allFiles.includes('angular.json')) out.push('Angular');
  return out;
}

function detectTestFrameworks(allDeps, files, contents) {
  const out = [];
  const add = n => { if (!out.includes(n)) out.push(n); };
  const cfg = files.testConfigFiles.map(baseName).join(' ');
  if (allDeps.vitest || /vitest/.test(cfg)) add('Vitest');
  if (allDeps.jest || allDeps['@jest/core'] || allDeps['ts-jest'] || /jest\.config/.test(cfg)) add('Jest');
  if (allDeps.mocha || /mocharc/.test(cfg)) add('Mocha');
  if (allDeps.jasmine || /jasmine/.test(cfg)) add('Jasmine');
  if (allDeps['@playwright/test'] || /playwright\.config/.test(cfg)) add('Playwright');
  if (allDeps.cypress || /cypress/.test(cfg)) add('Cypress');
  const py = files.testFiles.filter(f => f.endsWith('.py'));
  if (allDeps.pytest || /pytest\.ini|conftest\.py/.test(cfg) || (contents.get('pyproject.toml') || '').includes('[tool.pytest')) add('Pytest');
  else if (py.length) add(py.some(f => /import unittest|from unittest/.test(contents.get(f) || '')) ? 'unittest' : 'Pytest');
  if (files.testFiles.some(f => f.endsWith('_test.go'))) add('Go test');
  if (files.sourceFiles.concat(files.testFiles).some(f => f.endsWith('.rs') && /#\[test\]/.test(contents.get(f) || ''))) add('Cargo test');
  if (allDeps['rspec'] || allDeps['rspec-rails'] || /\.rspec/.test(cfg)) add('RSpec');
  if (allDeps['phpunit/phpunit'] || /phpunit/.test(cfg)) add('PHPUnit');
  if (Object.keys(allDeps).some(k => /junit/.test(k))) add('JUnit');
  if (!out.length && files.testFiles.length) add('Unknown framework');
  return out;
}

function countTestCases(text) {
  const m = text.match(/(^|[^\w.])(it|test)(\.each\([^)]*\))?\s*\(\s*['"`]|^\s*(async\s+)?def test_\w+|^func Test\w+\(|#\[test\]|@Test\b|^\s*(it|specify|scenario)\s+['"]/gm);
  return m ? m.length : 0;
}

// ------------------------------------------------------------------
// Entry points & routes
// ------------------------------------------------------------------
const ENTRY_CANDIDATES = [
  'index.js', 'index.ts', 'main.js', 'main.ts', 'server.js', 'server.ts', 'app.js', 'app.ts',
  'src/index.js', 'src/index.ts', 'src/index.tsx', 'src/main.js', 'src/main.ts', 'src/main.tsx', 'src/server.js', 'src/server.ts', 'src/app.js', 'src/app.ts',
  'app/layout.tsx', 'app/page.tsx', 'src/app/layout.tsx', 'pages/_app.tsx', 'pages/_app.js', 'src/pages/_app.tsx',
  'manage.py', 'app.py', 'main.py', 'wsgi.py', 'asgi.py', 'src/main.py', 'main.go', 'src/main.rs', 'src/lib.rs', 'Program.cs',
  'config/routes.rb', 'artisan', 'public/index.php',
];

function findEntryPoints(files, contents, rootPkg) {
  const set = new Set(files.allFiles);
  const out = [];
  const add = (path, reason) => { if (path && set.has(path) && !out.some(e => e.path === path)) out.push({ path, reason }); };
  if (rootPkg) {
    if (rootPkg.main) add(posix.normalize(rootPkg.main), 'package.json "main"');
    const bins = typeof rootPkg.bin === 'string' ? [rootPkg.bin] : Object.values(rootPkg.bin || {});
    bins.forEach(b => add(posix.normalize(b), 'package.json "bin"'));
    const start = (rootPkg.scripts || {}).start || '';
    const m = start.match(/(?:node|ts-node|tsx|nodemon|bun)\s+([^\s]+\.[cm]?[jt]sx?)/);
    if (m) add(posix.normalize(m[1]), 'npm start script');
  }
  ENTRY_CANDIDATES.forEach(p => add(p, 'Conventional entry point'));
  for (const f of files.sourceFiles) {
    if (out.length >= 12) break;
    const t = contents.get(f);
    if (!t) continue;
    if (f.endsWith('.go') && /^package main\b/m.test(t) && /^func main\(\)/m.test(t)) add(f, 'Go main package');
    else if (f.endsWith('.py') && /if __name__ == ['"]__main__['"]/.test(t) && f.split('/').length <= 3) add(f, 'Python __main__ block');
  }
  return out.slice(0, 12);
}

function extractRoutes(files, contents) {
  const routes = [];
  const mounts = {}; // Express-style `app.use('/prefix', someRouter)`
  const push = (method, path, file, kind) => {
    if (routes.length >= 300 || routes.some(r => r.method === method && r.path === path && r.file === file)) return {};
    const r = { method, path, file, kind };
    routes.push(r);
    return r;
  };
  for (const f of files.sourceFiles) {
    const t = contents.get(f);
    // File-system routing (Next.js)
    const pagesApi = f.match(/(?:^|\/)pages\/(api\/.+)\.(t|j)sx?$/);
    if (pagesApi) push('ANY', '/' + pagesApi[1].replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1'), f, 'Next.js API');
    const appRoute = f.match(/(?:^|\/)app\/(.*?)\/?route\.(t|j)s$/);
    if (appRoute && t) {
      const p = '/' + appRoute[1].split('/').filter(s => !/^\(.*\)$/.test(s)).join('/').replace(/\[([^\]]+)\]/g, ':$1');
      const methods = [...t.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map(m => m[1]);
      (methods.length ? methods : ['ANY']).forEach(m => push(m, p.replace(/\/$/, '') || '/', f, 'Next.js route'));
    }
    if (!t) continue;
    if (/\.(m|c)?[jt]sx?$/.test(f)) {
      for (const m of t.matchAll(/\.use\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) mounts[m[2]] = m[1];
      for (const m of t.matchAll(/\b(\w*(?:app|router|server|api|routes?)|fastify|r|v\d)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*(['"`])(\/[^'"`]*)\3/gi)) {
        push(m[2].toUpperCase(), m[4], f, 'HTTP route').obj = m[1];
      }
      const ctrl = t.match(/@Controller\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/);
      if (ctrl) {
        const prefix = '/' + ctrl[1].replace(/^\//, '');
        for (const m of t.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) push(m[1].toUpperCase(), posix.join(prefix, m[2] || '') || '/', f, 'NestJS');
      }
    } else if (f.endsWith('.py')) {
      for (const m of t.matchAll(/@\w+\.(route|get|post|put|patch|delete|api_route)\(\s*['"]([^'"]+)['"]([^)]*)\)/g)) {
        let method = m[1] === 'route' || m[1] === 'api_route' ? 'GET' : m[1].toUpperCase();
        const mm = m[3].match(/methods\s*=\s*\[([^\]]+)\]/);
        if (mm) method = mm[1].replace(/['"\s]/g, '').toUpperCase().replace(/,/g, '|');
        push(method, m[2], f, 'Python route');
      }
      if (/urls\.py$/.test(f)) for (const m of t.matchAll(/\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]/g)) push('ANY', '/' + m[1].replace(/^\^|\$$/g, ''), f, 'Django URL');
    } else if (f.endsWith('.go')) {
      for (const m of t.matchAll(/\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"/g)) push(/^Handle/.test(m[1]) ? 'ANY' : m[1].toUpperCase(), m[2], f, 'Go route');
    } else if (/\.(java|kt)$/.test(f)) {
      const base = (t.match(/@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/) || [])[1] || '';
      for (const m of t.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/g)) push(m[1].toUpperCase(), posix.join('/', base, m[2]), f, 'Spring');
    } else if (f.endsWith('routes.rb')) {
      for (const m of t.matchAll(/^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm)) push(m[1].toUpperCase(), m[2].startsWith('/') ? m[2] : '/' + m[2], f, 'Rails');
      for (const m of t.matchAll(/^\s*resources?\s+:(\w+)/gm)) push('REST', '/' + m[1], f, 'Rails');
    } else if (f.endsWith('.php')) {
      for (const m of t.matchAll(/Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]/g)) push(m[1].toUpperCase(), m[2].startsWith('/') ? m[2] : '/' + m[2], f, 'Laravel');
    }
  }
  for (const r of routes) {
    if (r.obj && mounts[r.obj]) r.path = posix.join(mounts[r.obj], r.path).replace(/(.)\/$/, '$1');
    delete r.obj;
  }
  return routes;
}

// ------------------------------------------------------------------
// Import graph
// ------------------------------------------------------------------
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

function buildImportGraph(files, contents, goModule) {
  const fileSet = new Set(files.sourceFiles.concat(files.testFiles));
  const byDir = new Map();
  for (const f of fileSet) {
    const d = posix.dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }

  const resolveJs = (from, spec) => {
    let base;
    if (spec.startsWith('.')) base = posix.join(posix.dirname(from), spec);
    else if (spec.startsWith('@/') || spec.startsWith('~/')) base = spec.slice(2);
    else return [];
    const tries = [base, ...JS_EXT.map(e => base + e), ...JS_EXT.map(e => `${base}/index${e}`)];
    if (!spec.startsWith('.')) tries.push(...tries.map(t => 'src/' + t));
    // TypeScript ESM style: import './x.js' that is really x.ts
    if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
    const hit = tries.find(t => fileSet.has(t));
    return hit ? [hit] : [];
  };

  const resolvePy = (from, mod, level) => {
    let parts = mod ? mod.split('.') : [];
    let roots;
    if (level > 0) {
      let dir = posix.dirname(from);
      for (let i = 1; i < level; i++) dir = posix.dirname(dir);
      roots = [dir === '.' ? '' : dir];
    } else {
      roots = ['', 'src', posix.dirname(from)];
    }
    for (const root of roots) {
      const base = [root, ...parts].filter(Boolean).join('/');
      for (const cand of [base + '.py', base + '/__init__.py']) if (fileSet.has(cand)) return [cand];
    }
    return [];
  };

  const graph = {};
  for (const f of fileSet) {
    const t = contents.get(f);
    if (!t) continue;
    const targets = new Set();
    if (/\.(m|c)?[jt]sx?$|\.vue$|\.svelte$/.test(f)) {
      for (const m of t.matchAll(/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
        resolveJs(f, m[1] || m[2] || m[3] || m[4]).forEach(x => targets.add(x));
      }
    } else if (f.endsWith('.py')) {
      for (const m of t.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w*, ()]+)/gm)) {
        const level = m[1].length;
        const hit = resolvePy(f, m[2], level);
        if (hit.length) hit.forEach(x => targets.add(x));
        // `from pkg import module`
        for (const name of m[3].replace(/[()]/g, '').split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean)) {
          resolvePy(f, [m[2], name].filter(Boolean).join('.'), level).forEach(x => targets.add(x));
        }
      }
      for (const m of t.matchAll(/^\s*import\s+([\w.]+)/gm)) resolvePy(f, m[1], 0).forEach(x => targets.add(x));
    } else if (f.endsWith('.go') && goModule) {
      for (const m of t.matchAll(/"([^"\s]+)"/g)) {
        if (!m[1].startsWith(goModule + '/')) continue;
        (byDir.get(m[1].slice(goModule.length + 1)) || []).filter(x => !x.endsWith('_test.go')).slice(0, 25).forEach(x => targets.add(x));
      }
    }
    targets.delete(f);
    if (targets.size) graph[f] = [...targets];
  }
  // Go: tests in a package directory exercise that package.
  for (const tf of files.testFiles.filter(x => x.endsWith('_test.go'))) {
    const same = (byDir.get(posix.dirname(tf)) || []).filter(x => !x.endsWith('_test.go'));
    graph[tf] = [...new Set([...(graph[tf] || []), ...same])];
  }
  return graph;
}

// ------------------------------------------------------------------
// Modules, test reach
// ------------------------------------------------------------------
const CONTAINERS = new Set(['src', 'lib', 'packages', 'apps', 'internal', 'pkg', 'cmd', 'source', 'modules', 'crates', 'services']);

function moduleKey(file, extraDepth) {
  const dirs = file.split('/').slice(0, -1);
  if (!dirs.length) return '(root)';
  let depth = (CONTAINERS.has(dirs[0]) ? 2 : 1) + extraDepth;
  return dirs.slice(0, depth).join('/');
}

function buildModules(sourceFiles) {
  let extra = 0;
  let keys;
  for (;;) {
    keys = new Map(sourceFiles.map(f => [f, moduleKey(f, extra)]));
    const distinct = new Set(keys.values()).size;
    if (distinct >= 3 || extra >= 2 || sourceFiles.length < 10) break;
    const deeper = new Set(sourceFiles.map(f => moduleKey(f, extra + 1))).size;
    if (deeper <= distinct) break;
    extra++;
  }
  const groups = new Map();
  for (const f of sourceFiles) {
    const k = keys.get(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  let list = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const MAX = 14;
  if (list.length > MAX) {
    const rest = list.slice(MAX - 1).flatMap(([, fs]) => fs);
    list = list.slice(0, MAX - 1).concat([['(other)', rest]]);
  }
  const fileToModule = {};
  const modules = list.map(([id, fs]) => {
    fs.forEach(f => { fileToModule[f] = id; });
    return { id, label: id === '(root)' ? 'Root files' : id === '(other)' ? 'Other modules' : id, files: fs.sort() };
  });
  return { modules, fileToModule };
}

function stemOf(p) {
  return baseName(p)
    .replace(/\.(test|spec)(?=\.)/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/^test_/, '')
    .replace(/_(test|spec)$/, '')
    .replace(/Tests?$/, '')
    .toLowerCase();
}

function computeTestReach(files, graph) {
  const reached = new Set();
  const stems = new Map();
  for (const f of files.sourceFiles) {
    const s = stemOf(f);
    if (s === 'index' || s === '__init__') continue;
    if (!stems.has(s)) stems.set(s, []);
    stems.get(s).push(f);
  }
  const testTargets = {};
  for (const t of files.testFiles) {
    const direct = new Set(graph[t] || []);
    (stems.get(stemOf(t)) || []).forEach(f => direct.add(f));
    const all = new Set(direct);
    // follow imports two more hops: code exercised through the unit under test
    let frontier = [...direct];
    for (let hop = 0; hop < 2; hop++) {
      const next = [];
      for (const f of frontier) for (const g of graph[f] || []) if (!all.has(g)) { all.add(g); next.push(g); }
      frontier = next;
    }
    const srcTargets = [...all].filter(f => !files.testFiles.includes(f));
    srcTargets.forEach(f => reached.add(f));
    testTargets[t] = [...direct].filter(f => !files.testFiles.includes(f));
  }
  return { reached, testTargets };
}

// ------------------------------------------------------------------
// Code facts: env vars, TODOs, symbols, sizes
// ------------------------------------------------------------------
const ENV_IGNORE = new Set(['NODE_ENV', 'CI', 'HOME', 'PATH', 'PWD', 'TZ', 'LANG', 'USER', 'SHELL', 'TERM', 'TMPDIR', 'DEBUG', 'VERCEL', 'NETLIFY']);

function envFacts(files, contents) {
  const documented = new Set();
  for (const f of files.envTemplates) {
    for (const m of (contents.get(f) || '').matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)) documented.add(m[1]);
  }
  const used = {};
  const note = (name, f) => {
    if (ENV_IGNORE.has(name) || name.startsWith('npm_')) return;
    if (!used[name]) used[name] = [];
    if (used[name].length < 3 && !used[name].includes(f)) used[name].push(f);
  };
  for (const f of files.sourceFiles) {
    const t = contents.get(f);
    if (!t) continue;
    for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]|import\.meta\.env\.([A-Z][A-Z0-9_]*)|os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]*)['"]|os\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]|os\.Getenv\(\s*"([A-Z][A-Z0-9_]*)"|ENV\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]|env::var\(\s*"([A-Z][A-Z0-9_]*)"|getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      note(m.slice(1).find(Boolean), f);
    }
  }
  const missing = Object.keys(used).filter(k => !documented.has(k) && !/^(VITE|NEXT_PUBLIC)_?$/.test(k)).sort();
  return { envDocumented: [...documented].sort(), envUsed: used, envMissing: missing };
}

function codeFacts(files, contents) {
  const todos = [];
  const largeFiles = [];
  const lines = {};
  const symbols = {};
  const cjsFiles = [];
  let totalTodos = 0;
  for (const f of files.sourceFiles.concat(files.testFiles)) {
    const t = contents.get(f);
    if (t == null) continue;
    const n = t.split('\n').length;
    lines[f] = n;
    const c = (t.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;
    if (c) { totalTodos += c; todos.push({ path: f, count: c }); }
    if (n > 800 && !files.testFiles.includes(f)) largeFiles.push({ path: f, lines: n });
    if (!files.testFiles.includes(f)) {
      const names = new Set();
      if (/\.(m|c)?[jt]sx?$/.test(f)) {
        if (/module\.exports|(^|[^.\w])exports\.\w+\s*=/.test(t) && !/^\s*export\s/m.test(t)) cjsFiles.push(f);
        for (const m of t.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
        const ce = t.match(/module\.exports\s*=\s*\{([^}]*)\}/);
        if (ce) ce[1].split(',').map(s => s.trim().split(/[\s:]/)[0]).filter(s => /^[A-Za-z_$][\w$]*$/.test(s)).forEach(s => names.add(s));
        for (const m of t.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
        if (!names.size && /module\.exports\s*=\s*([A-Za-z_$][\w$]*)/.test(t)) names.add(t.match(/module\.exports\s*=\s*([A-Za-z_$][\w$]*)/)[1]);
      } else if (f.endsWith('.py')) {
        for (const m of t.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm)) names.add(m[1]);
      } else if (f.endsWith('.go')) {
        for (const m of t.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\(/gm)) names.add(m[1]);
      } else if (f.endsWith('.rb')) {
        for (const m of t.matchAll(/^\s*(?:class|module)\s+([A-Z]\w*)|^\s*def\s+(?:self\.)?([a-z_]\w*[?!]?)/gm)) names.add(m[1] || m[2]);
      }
      if (names.size) symbols[f] = [...names].slice(0, 15);
    }
  }
  todos.sort((a, b) => b.count - a.count);
  largeFiles.sort((a, b) => b.lines - a.lines);
  return { totalTodos, todoFiles: todos.slice(0, 10), largeFiles: largeFiles.slice(0, 10), lines, symbols, cjsFiles };
}

// ------------------------------------------------------------------
// Docker, CI, docs
// ------------------------------------------------------------------
function dockerFacts(files, contents) {
  return files.allFiles.filter(f => /(^|\/)Dockerfile[^/]*$/.test(f) && !isIgnored(f)).slice(0, 5).map(f => {
    const t = contents.get(f) || '';
    const froms = [...t.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map(m => m[1]);
    const stageNames = new Set([...t.matchAll(/^\s*FROM\s+\S+(?:\s+\S+)*\s+AS\s+(\S+)/gim)].map(m => m[1].toLowerCase()));
    const external = froms.filter(b => !stageNames.has(b.toLowerCase()) && b.toLowerCase() !== 'scratch');
    return {
      path: f,
      baseImages: froms,
      usesLatest: external.some(b => !b.includes(':') && !b.includes('@') || /:latest$/.test(b)),
      runsAsRoot: !/^\s*USER\s+(?!root\b)\S+/im.test(t),
      exposes: [...t.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].map(m => m[1].trim()),
      cmd: ((t.match(/^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/gim) || []).pop() || '').replace(/^\s*(CMD|ENTRYPOINT)\s+/i, '').slice(0, 160),
      multiStage: froms.length > 1,
    };
  });
}

const TEST_CMD = /\b(npm (run )?test|npm run test[:\w-]*|yarn (run )?test|pnpm (run )?test|bun test|npx (jest|vitest|playwright|cypress)|jest\b|vitest\b|pytest|python -m (pytest|unittest)|go test|cargo test|mvn[^\n]*\b(test|verify)\b|gradlew? [^\n]*test|rspec|rake test|bin\/rails test|phpunit|dotnet test|tox\b|nox\b|make test)/i;
const LINT_CMD = /\b(eslint|npm run lint|yarn lint|pnpm lint|ruff|flake8|pylint|golangci-lint|cargo clippy|rubocop|prettier --check|tsc\b|mypy)/i;
const DEPLOY_CMD = /\b(deploy|docker push|kubectl|helm upgrade|vercel|netlify deploy|flyctl|fly deploy|aws |gcloud|heroku|serverless|terraform apply|gh-pages|pages deploy)/i;

function ciFacts(files, contents) {
  return files.ciFiles.map(f => {
    const t = contents.get(f) || '';
    const name = (t.match(/^name:\s*['"]?([^'"\n]+)/m) || [])[1] || baseName(f);
    let triggers = [];
    const onInline = t.match(/^on:\s*\[?([^\n\]]+)\]?\s*$/m);
    if (onInline && onInline[1].trim()) triggers = onInline[1].split(',').map(s => s.trim()).filter(Boolean);
    else {
      const block = t.match(/^on:\s*\n((?:[ \t]+.*\n?)+)/m);
      if (block) triggers = [...block[1].matchAll(/^[ \t]{2}([a-z_]+):?/gm)].map(m => m[1]);
    }
    return { path: f, name: name.trim(), triggers, runsTests: TEST_CMD.test(t), runsLint: LINT_CMD.test(t), deploys: DEPLOY_CMD.test(t) };
  });
}

function docFacts(files, contents) {
  const readmePath = files.allFiles.find(f => /^readme(\.[a-z]+)?$/i.test(f)) || files.allFiles.find(f => /(^|\/)readme\.md$/i.test(f) && !isIgnored(f));
  const readme = readmePath ? contents.get(readmePath) || '' : '';
  const sections = [...readme.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].replace(/[#*`]/g, '').trim()).slice(0, 30);
  return {
    readmePath: readmePath || null,
    readmeContent: readme.slice(0, 8000),
    readmeSections: sections,
    readmeHasSetup: /install|setup|getting started|quick ?start|usage|development/i.test(sections.join(' ')),
    hasContributing: files.allFiles.some(f => /^contributing(\.[a-z]+)?$/i.test(baseName(f))),
    hasChangelog: files.allFiles.some(f => /^(changelog|history|releases)(\.[a-z]+)?$/i.test(baseName(f))),
    hasLicense: files.allFiles.some(f => /^(license|licence|copying)(\.[a-z]+)?$/i.test(baseName(f))),
  };
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
function analyzeRepository({ paths, contents, meta = {}, coverage = {} }) {
  const files = classify(paths);
  const manifests = parseManifests(files, contents);
  const rootPkgManifest = manifests.find(m => m.ecosystem === 'npm');
  const rootPkg = rootPkgManifest ? rootPkgManifest.pkg : null;

  const dependencies = {};
  const devDependencies = {};
  for (const m of manifests) {
    for (const [k, v] of Object.entries(m.deps)) if (!(k in dependencies)) dependencies[k] = String(v);
    for (const [k, v] of Object.entries(m.devDeps)) if (!(k in devDependencies) && !(k in dependencies)) devDependencies[k] = String(v);
  }
  const allDeps = { ...dependencies, ...devDependencies };

  const ecosystems = [...new Set(manifests.map(m => m.ecosystem))];
  const lockEcosystems = new Set(files.lockfiles.map(f => LOCKFILES[baseName(f)]));
  const pinnedRequirements = manifests.filter(m => m.ecosystem === 'python' && /requirements/.test(m.path))
    .every(m => Object.values(m.deps).every(v => /^==/.test(v)));
  const missingLockfiles = ecosystems.filter(e => {
    if (lockEcosystems.has(e)) return false;
    if (e === 'python' && pinnedRequirements && manifests.some(m => /requirements/.test(m.path))) return false;
    return ['npm', 'python', 'go', 'ruby', 'php', 'rust'].includes(e);
  });

  const frameworks = detectFrameworks(allDeps, files);
  const testFrameworks = detectTestFrameworks(allDeps, files, contents);
  const goManifest = manifests.find(m => m.ecosystem === 'go');
  const graph = buildImportGraph(files, contents, goManifest ? goManifest.goModule : null);
  const { modules, fileToModule } = buildModules(files.sourceFiles);
  const { reached, testTargets } = computeTestReach(files, graph);
  const routes = extractRoutes(files, contents);
  const entryPoints = findEntryPoints(files, contents, rootPkg);
  const env = envFacts(files, contents);
  const code = codeFacts(files, contents);
  const docs = docFacts(files, contents);
  const docker = dockerFacts(files, contents);
  const ci = ciFacts(files, contents);

  // Module-level aggregation
  const edgeCount = {};
  for (const [from, tos] of Object.entries(graph)) {
    const a = fileToModule[from];
    if (!a) continue;
    for (const to of tos) {
      const b = fileToModule[to];
      if (b && b !== a) edgeCount[`${a}\u0000${b}`] = (edgeCount[`${a}\u0000${b}`] || 0) + 1;
    }
  }
  const moduleEdges = Object.entries(edgeCount).map(([k, w]) => { const [a, b] = k.split('\u0000'); return [a, b, w]; });
  const docTexts = files.docFiles.map(f => [f, (contents.get(f) || '').toLowerCase()]);
  const entrySet = new Set(entryPoints.map(e => e.path));
  for (const mod of modules) {
    const set = new Set(mod.files);
    mod.fileCount = mod.files.length;
    mod.lines = mod.files.reduce((s, f) => s + (code.lines[f] || 0), 0);
    mod.reachedFiles = mod.files.filter(f => reached.has(f)).length;
    mod.reachPct = mod.fileCount ? Math.round((mod.reachedFiles / mod.fileCount) * 100) : 0;
    mod.testFiles = Object.entries(testTargets).filter(([, ts]) => ts.some(f => set.has(f))).map(([t]) => t);
    mod.routes = routes.filter(r => set.has(r.file)).length;
    mod.hasEntry = mod.files.some(f => entrySet.has(f));
    mod.todos = code.todoFiles.filter(t => set.has(t.path)).reduce((s, t) => s + t.count, 0);
    mod.importsFrom = moduleEdges.filter(e => e[0] === mod.id).map(e => e[1]);
    mod.importedBy = moduleEdges.filter(e => e[1] === mod.id).map(e => e[0]);
    const needle = mod.id.split('/').pop().toLowerCase();
    mod.docs = needle.length >= 3 && !mod.id.startsWith('(') ? docTexts.filter(([, t]) => t.includes(needle)).map(([f]) => f).slice(0, 6) : [];
  }

  const testCases = {};
  for (const t of files.testFiles) if (contents.has(t)) testCases[t] = countTestCases(contents.get(t));

  const MAX_PATHS = 20000;
  return {
    name: meta.name,
    fullName: meta.full_name,
    owner: meta.owner,
    language: meta.language || 'Unknown',
    branch: meta.branch,
    description: meta.description || (rootPkg && rootPkg.description) || '',
    isPrivate: !!meta.private,
    visibility: meta.visibility,
    stars: meta.stars || 0,
    url: meta.html_url,
    commit: meta.commit || null,

    allFiles: files.allFiles.slice(0, MAX_PATHS),
    totalFiles: files.allFiles.length,
    sourceFiles: files.sourceFiles,
    testFiles: files.testFiles,
    configFiles: files.configFiles.slice(0, 500),
    docFiles: files.docFiles.slice(0, 500),
    deployFiles: files.deployFiles,
    ciFiles: files.ciFiles,
    lockfiles: files.lockfiles,
    testConfigFiles: files.testConfigFiles,
    envTemplates: files.envTemplates,
    dockerfile: docker.length > 0,

    packageJson: sanitizePackageJson(rootPkg),
    requirementsTxt: contents.has('requirements.txt') ? contents.get('requirements.txt').slice(0, 20000) : null,
    goMod: contents.has('go.mod') ? contents.get('go.mod').slice(0, 20000) : null,
    cargoToml: contents.has('Cargo.toml') ? contents.get('Cargo.toml').slice(0, 20000) : null,
    manifests: manifests.map(m => ({ path: m.path, ecosystem: m.ecosystem, deps: Object.keys(m.deps).length, devDeps: Object.keys(m.devDeps).length })),
    ecosystems,
    missingLockfiles,
    dependencies,
    devDependencies,

    frameworks,
    framework: frameworks[0] || null,
    testFrameworks,
    testFramework: testFrameworks[0] || null,
    testCases,
    entryPoints,
    routes,
    importGraph: graph,
    modules,
    moduleEdges,
    fileToModule,
    testReached: [...reached],
    testTargets,
    symbols: code.symbols,
    cjsFiles: code.cjsFiles,
    largeFiles: code.largeFiles,
    todoFiles: code.todoFiles,
    totalTodos: code.totalTodos,
    ...env,
    ...docs,
    docker,
    ci,
    analysis: {
      mode: coverage.mode || 'archive',
      filesRead: contents.size,
      pathsTruncated: files.allFiles.length > MAX_PATHS,
      treeTruncated: !!coverage.treeTruncated,
      skipped: coverage.skipped || 0,
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = { analyzeRepository, classify, wantContent, isSource, isTest, stemOf, moduleKey, countTestCases };
