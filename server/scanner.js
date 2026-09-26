'use strict';
// Repository scan: GitHub (read-only) → snapshot → analysis → Project Model.
// Progress is reported through `emit(event)` so the UI can show real stages.

const zlib = require('zlib');
const { Readable } = require('stream');
const { TarExtractor } = require('./tar');
const { analyzeRepository, classify, wantContent } = require('./analyze');
const { GitHubError } = require('./github');

const TRIVIAL = /(^|\/)(LICEN[CS]E(\.[a-z]+)?|\.gitignore|\.gitattributes|\.gitkeep|\.editorconfig)$/i;

async function readArchive(resp, { maxArchiveBytes, maxFileBytes, maxFilesAnalysed }) {
  const contents = new Map();
  const paths = [];
  let kept = 0;
  let skipped = 0;
  let budget = 64 * 1024 * 1024; // total bytes of text kept in memory

  const tar = new TarExtractor({
    want: (rawPath, size) => {
      const p = rawPath.split('/').slice(1).join('/');
      if (!p) return false;
      paths.push(p);
      if (!wantContent(p, size, maxFileBytes)) return false;
      if (kept >= maxFilesAnalysed || size > budget) { skipped++; return false; }
      kept++;
      budget -= size;
      return true;
    },
    onFile: (rawPath, buf) => {
      const p = rawPath.split('/').slice(1).join('/');
      if (buf.includes(0)) return; // binary
      contents.set(p, buf.toString('utf8'));
    },
  });

  const declared = parseInt(resp.headers.get('content-length') || '0', 10);
  if (declared && declared > maxArchiveBytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });

  await new Promise((resolve, reject) => {
    let received = 0;
    const src = Readable.fromWeb(resp.body);
    const gunzip = zlib.createGunzip();
    src.on('data', chunk => {
      received += chunk.length;
      if (received > maxArchiveBytes) {
        src.destroy();
        gunzip.destroy();
        reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
      }
    });
    src.on('error', reject);
    gunzip.on('error', reject);
    gunzip.on('data', chunk => tar.write(chunk));
    gunzip.on('end', resolve);
    src.pipe(gunzip);
  });
  return { contents, paths, skipped };
}

// Fallback for very large repositories: read the most informative files one by one.
async function readSelectedFiles(gh, owner, repo, sha, tree, cfg) {
  const files = classify(tree.map(t => t.path));
  const sizes = new Map(tree.map(t => [t.path, t.size || 0]));
  const important = [
    ...files.manifestFiles, ...files.envTemplates, ...files.ciFiles, ...files.testConfigFiles,
    ...files.allFiles.filter(f => /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Procfile)$/.test(f)),
    ...files.allFiles.filter(f => /^readme(\.[a-z]+)?$/i.test(f)),
  ];
  const byDepth = arr => arr.slice().sort((a, b) => a.split('/').length - b.split('/').length);
  const code = byDepth(files.sourceFiles).slice(0, 220).concat(byDepth(files.testFiles).slice(0, 80));
  const wanted = [...new Set(important.concat(code))].filter(p => (sizes.get(p) || 0) <= cfg.scan.maxFileBytes);
  const contents = new Map();
  let i = 0;
  const worker = async () => {
    while (i < wanted.length) {
      const p = wanted[i++];
      try {
        const text = await gh.file(owner, repo, p, sha);
        if (text && !text.includes('\u0000')) contents.set(p, text);
      } catch (e) {
        if (e.code === 'rate_limited') throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { contents, skipped: files.sourceFiles.length + files.testFiles.length - code.length };
}

async function scanRepository(gh, cfg, owner, repo, ref, emit) {
  const stage = (id, state, detail = '') => emit({ type: 'stage', id, state, detail });
  const counts = { 'files discovered': '…', 'source files': '—', 'test files': '—', dependencies: '—', docs: '—' };

  // 1. Repository metadata — confirms access
  stage('s-connect', 'running');
  stage('ag-arch', 'running');
  const meta = await gh.repo(owner, repo);
  if (!meta || meta.size === 0) throw new GitHubError('empty', 409);
  const branch = ref || meta.default_branch;
  stage('s-connect', 'done', `github.com/${meta.full_name}`);

  // 2. Snapshot: resolve branch → commit, then list every file
  stage('s-tree', 'running');
  const commit = await gh.commit(owner, repo, branch);
  const sha = commit.sha;
  const treeResp = await gh.tree(owner, repo, commit.commit.tree.sha);
  const tree = (treeResp.tree || []).filter(t => t.type === 'blob');
  const meaningful = tree.filter(t => !TRIVIAL.test(t.path));
  if (!tree.length || !meaningful.length) throw new GitHubError('empty', 409);
  counts['files discovered'] = tree.length;
  emit({ type: 'counts', counts });
  stage('s-tree', 'done', `${tree.length}${treeResp.truncated ? '+' : ''} files in ${branch} @ ${sha.slice(0, 7)}`);

  // 3. Contents: one archive download, or file-by-file for very large repos
  stage('s-manifest', 'running', 'Downloading repository snapshot');
  stage('ag-dep', 'running');
  let contents, paths = tree.map(t => t.path), skipped = 0, mode = 'archive';
  try {
    const resp = await gh.tarball(owner, repo, sha);
    const r = await readArchive(resp, cfg.scan);
    contents = r.contents;
    skipped = r.skipped;
    if (treeResp.truncated && r.paths.length > paths.length) paths = r.paths;
  } catch (e) {
    if (e instanceof GitHubError && e.code !== 'unavailable') throw e;
    mode = 'sampled';
    stage('s-manifest', 'running', 'Large repository — reading key files individually');
    const r = await readSelectedFiles(gh, owner, repo, sha, tree, cfg);
    contents = r.contents;
    skipped = r.skipped;
  }

  const model = analyzeRepository({
    paths,
    contents,
    meta: {
      name: meta.name, full_name: meta.full_name, owner: meta.owner && meta.owner.login, language: meta.language,
      description: meta.description, private: meta.private, visibility: meta.visibility, stars: meta.stargazers_count,
      html_url: meta.html_url, branch,
      commit: {
        sha,
        message: (commit.commit.message || '').split('\n')[0].slice(0, 200),
        date: commit.commit.author && commit.commit.author.date,
        author: (commit.author && commit.author.login) || (commit.commit.author && commit.commit.author.name) || '',
      },
    },
    coverage: { mode, treeTruncated: !!treeResp.truncated, skipped },
  });

  const depCount = Object.keys(model.dependencies).length + Object.keys(model.devDependencies).length;
  counts['source files'] = model.sourceFiles.length;
  counts['test files'] = model.testFiles.length;
  counts.dependencies = depCount || 0;
  counts.docs = model.docFiles.length;
  emit({ type: 'counts', counts });

  stage('s-manifest', 'done', model.manifests.length
    ? `${model.manifests.length} manifest${model.manifests.length > 1 ? 's' : ''} · ${depCount} dependencies${model.lockfiles.length ? ' · lockfile' : ''}`
    : 'No dependency manifest found');
  stage('ag-dep', 'done');

  stage('s-tests', 'running');
  stage('ag-test', 'running');
  stage('s-tests', 'done', `${model.testFiles.length} test files${model.testFramework ? ' · ' + model.testFrameworks.join(', ') : ''}`);
  stage('ag-test', 'done');

  stage('s-docs', 'running');
  stage('ag-docs', 'running');
  stage('s-docs', 'done', `${model.docFiles.length} documentation files${model.readmePath ? '' : ' · no README'}`);
  stage('ag-docs', 'done');

  stage('s-config', 'running');
  stage('ag-cfg', 'running');
  stage('s-config', 'done', [
    model.envTemplates.length ? '.env template' : null,
    model.envMissing.length ? `${model.envMissing.length} undocumented env vars` : null,
    model.routes.length ? `${model.routes.length} API routes` : null,
  ].filter(Boolean).join(' · ') || 'scanned');
  stage('ag-cfg', 'done');

  stage('s-deploy', 'running');
  stage('ag-dep2', 'running');
  stage('s-deploy', 'done', `${model.docker.length ? 'Dockerfile · ' : ''}${model.ci.length} CI workflow${model.ci.length !== 1 ? 's' : ''}`);
  stage('ag-dep2', 'done');
  stage('ag-arch', 'done');
  return model;
}

module.exports = { scanRepository, readArchive };
