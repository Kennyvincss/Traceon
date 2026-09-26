'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { analyzeRepository, classify, stemOf } = require('../server/analyze');

function loadDir(root) {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const paths = walk(root).map(p => path.relative(root, p).split(path.sep).join('/'));
  return { paths, contents: new Map(paths.map(p => [p, fs.readFileSync(path.join(root, p), 'utf8')])) };
}

const sample = analyzeRepository({ ...loadDir(path.join(__dirname, 'fixtures/sample-repo')), meta: { name: 'sample-app' } });

test('classifies source, tests, docs, CI and lockfiles', () => {
  assert.deepStrictEqual(sample.testFiles, ['tests/users.test.ts']);
  assert.ok(sample.sourceFiles.includes('src/services/billing.ts'));
  assert.deepStrictEqual(sample.ciFiles, ['.github/workflows/ci.yml']);
  assert.deepStrictEqual(sample.lockfiles, ['package-lock.json']);
  assert.deepStrictEqual(sample.missingLockfiles, []);
  assert.strictEqual(sample.framework, 'Express.js');
  assert.strictEqual(sample.testFramework, 'Jest');
});

test('extracts routes with Express mount prefixes', () => {
  const r = sample.routes.map(x => `${x.method} ${x.path}`).sort();
  assert.deepStrictEqual(r, ['GET /health', 'GET /users', 'GET /users/:id', 'POST /billing/charge']);
});

test('builds the import graph, modules and test reach', () => {
  assert.deepStrictEqual(sample.importGraph['tests/users.test.ts'], ['src/services/userService.ts']);
  assert.deepStrictEqual(sample.modules.map(m => m.id).sort(), ['src', 'src/routes', 'src/services', 'src/utils']);
  assert.ok(sample.moduleEdges.some(([a, b]) => a === 'src/routes' && b === 'src/services'));
  assert.ok(sample.testReached.includes('src/utils/format.ts'), 'reached through userService');
  assert.ok(!sample.testReached.includes('src/services/billing.ts'));
});

test('finds undocumented env vars, Docker and CI facts, symbols', () => {
  assert.deepStrictEqual(sample.envMissing, ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
  assert.deepStrictEqual(sample.envDocumented, ['PORT']);
  assert.strictEqual(sample.docker[0].usesLatest, true);
  assert.strictEqual(sample.ci[0].runsTests, false);
  assert.deepStrictEqual(sample.symbols['src/services/billing.ts'], ['charge', 'Invoice']);
  assert.strictEqual(sample.testCases['tests/users.test.ts'], 2);
  assert.ok(sample.entryPoints.some(e => e.path === 'src/index.ts'));
});

test('never returns file contents other than manifests and a README excerpt', () => {
  const json = JSON.stringify(sample);
  assert.ok(!json.includes("currency is hard-coded"), 'source comments are not returned');
  assert.ok(!json.includes('formatName(u.first'), 'source code is not returned');
});

test('Python: relative imports, Flask routes, pytest reach', () => {
  const contents = new Map(Object.entries({
    'app/__init__.py': '',
    'app/api.py': "from flask import Flask\nfrom .models import User\napp = Flask(__name__)\n@app.route('/users', methods=['GET', 'POST'])\ndef users():\n    return os.getenv('SECRET_KEY')\n",
    'app/models.py': 'class User:\n    pass\n',
    'tests/test_models.py': 'from app.models import User\n\ndef test_user():\n    assert User\n',
    'requirements.txt': 'flask==2.0.1\npytest==7.0.0\n',
  }));
  const m = analyzeRepository({ paths: [...contents.keys()], contents, meta: {} });
  assert.deepStrictEqual(m.importGraph['app/api.py'], ['app/models.py']);
  assert.deepStrictEqual(m.routes.map(r => `${r.method} ${r.path}`), ['GET|POST /users']);
  assert.ok(m.testReached.includes('app/models.py'));
  assert.strictEqual(m.testFramework, 'Pytest');
  assert.strictEqual(m.framework, 'Flask');
  assert.deepStrictEqual(m.missingLockfiles, [], 'fully pinned requirements count as locked');
  assert.deepStrictEqual(m.envMissing, ['SECRET_KEY']);
});

test('Go: module imports and package tests', () => {
  const contents = new Map(Object.entries({
    'go.mod': 'module example.com/svc\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
    'main.go': 'package main\n\nimport "example.com/svc/internal/store"\n\nfunc main() { store.Open() }\n',
    'internal/store/store.go': 'package store\n\nfunc Open() {}\n',
    'internal/store/store_test.go': 'package store\n\nimport "testing"\n\nfunc TestOpen(t *testing.T) {}\n',
  }));
  const m = analyzeRepository({ paths: [...contents.keys()], contents, meta: {} });
  assert.deepStrictEqual(m.importGraph['main.go'], ['internal/store/store.go']);
  assert.ok(m.testReached.includes('internal/store/store.go'));
  assert.strictEqual(m.testFramework, 'Go test');
  assert.strictEqual(m.framework, 'Gin');
  assert.deepStrictEqual(m.missingLockfiles, ['go']);
  assert.ok(m.entryPoints.some(e => e.path === 'main.go'));
});

test('never reads real .env files, only templates', () => {
  const { wantContent } = require('../server/analyze');
  for (const f of ['.env', '.env.local', '.env.production', 'config/.env']) assert.strictEqual(wantContent(f, 10, 1e6), false, f);
  for (const f of ['.env.example', '.env.sample', 'src/app.ts', 'package.json']) assert.strictEqual(wantContent(f, 10, 1e6), true, f);
});

test('ignores vendored and build output', () => {
  const f = classify(['node_modules/x/index.js', 'dist/app.js', 'src/a.ts', 'src/a.test.ts', 'types.d.ts']);
  assert.deepStrictEqual(f.sourceFiles, ['src/a.ts']);
  assert.deepStrictEqual(f.testFiles, ['src/a.test.ts']);
  assert.strictEqual(stemOf('tests/test_user_service.py'), 'user_service');
});
