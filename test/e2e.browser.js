'use strict';
// Browser end-to-end test of the full user journey against a local GitHub stand-in:
// Continue with GitHub → authorize → repositories → Analyze → every Traceon page,
// error states, sign-out, Demo Project, and hostile repository content (XSS).
//
//   npm run test:e2e        (needs Playwright: npm i -g playwright && npx playwright install chromium)
//   PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:e2e
//   Screenshots are written to $E2E_SCREENSHOTS (default: OS temp dir).
process.env.NODE_ENV = 'test';
process.env.TRACEON_XSS_FIXTURE = '1';
const http = require('http');
const os = require('os');
const path = require('path');
const R = path.join(__dirname, '..');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright is not installed: npm i -g playwright (or npm i -D playwright)'); process.exit(2); }
const { createApp } = require(R + '/server/index');
const { loadConfig } = require(R + '/server/config');
const { startMockGitHub } = require(R + '/test/helpers/mock-github');
const SP = process.env.E2E_SCREENSHOTS || os.tmpdir();

(async () => {
  const gh = await startMockGitHub({ fixtureDir: path.join(R, 'test/fixtures/sample-repo') });
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  server.on('request', createApp({ cfg: loadConfig({ APP_URL: base, GITHUB_CLIENT_ID: 'Iv1.testclient', GITHUB_CLIENT_SECRET: 'test-secret', GITHUB_APP_SLUG: 'traceon-test', GITHUB_WEB_BASE: gh.base, GITHUB_API_BASE: gh.base }) }));

  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.route('https://avatars.githubusercontent.com/**', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="#8957e5"/></svg>' }));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, '—', e.message.split('\n')[0]); errs.push(name); } };
  const shot = n => p.screenshot({ path: `${SP}/${n}.png` });

  await p.goto(base);
  await step('landing has no token inputs', async () => {
    const txt = await p.locator('#cs-landing').innerText();
    if (!txt.includes('Continue with GitHub') || !txt.includes('Try Demo Project') || !txt.includes('Sign in with GitHub to securely access repositories you authorize for analysis.')) throw new Error(txt);
    if (await p.locator('input[type=password]').count()) throw new Error('password input present');
    if (/token|privy|wallet/i.test(await p.content().then(h => (h.match(/<div id="connect-screen">[\s\S]*?<!-- LOADING OVERLAY/) || [''])[0]))) throw new Error('token/privy text on connect screen');
  });
  await shot('01-landing');

  await step('cancelled login message', async () => {
    gh.state.denyNext = true;
    await p.click('#gh-continue-btn');
    await p.waitForSelector('#cs-landing-notice:has-text("GitHub login was cancelled.")');
  });

  await step('Continue with GitHub → GitHub → back to repositories', async () => {
    await p.click('#gh-continue-btn');
    await p.waitForSelector('#cs-gh-connected:has-text("GITHUB CONNECTED")');
    await p.waitForSelector('#cs-repo-list button:has-text("Analyze Repository")');
    const c = await p.locator('#cs-gh-connected').innerText();
    if (!c.includes('✓ Connected successfully') || !c.includes('@octo-dev')) throw new Error(c);
    if (p.url() !== base + '/') throw new Error('url not cleaned: ' + p.url());
    const n = await p.locator('#cs-repo-list button:has-text("Analyze Repository")').count();
    if (n !== 4) throw new Error('repos ' + n);
  });
  await shot('02-repos');

  await step('search + sort + empty search state', async () => {
    await p.fill('#cs-repo-search', 'sample');
    if (await p.locator('#cs-repo-list button:has-text("Analyze Repository")').count() !== 1) throw new Error('search');
    await p.fill('#cs-repo-search', 'zzz');
    await p.waitForSelector('#cs-repo-list:has-text("No repositories match")');
    await p.fill('#cs-repo-search', '');
    await p.selectOption('#cs-repo-sort', 'name');
    const first = await p.locator('#cs-repo-list > div').first().innerText();
    if (!first.startsWith('busy-repo')) throw new Error('sort: ' + first.slice(0, 30));
  });

  const analyze = async name => {
    await p.locator('#cs-repo-list > div', { hasText: name }).locator('button').click();
    await p.click('#cs-repo-confirm-body button:has-text("Analyze Repository")');
  };
  for (const [repo, msg] of [['busy-repo', 'GitHub temporarily limited requests. Please try again later.'],
                             ['empty-repo', 'This repository does not contain enough files for a complete analysis.'],
                             ['private-app', 'Traceon does not have permission to access this repository.']]) {
    await step(`error: ${repo}`, async () => {
      await analyze(repo);
      await p.waitForSelector(`#cs-scan-progress-body:has-text("${msg}")`, { timeout: 10000 });
      await p.click('#cs-scan-progress-body button:has-text("Choose another repository")');
    });
  }
  await shot('03-error');

  await step('scan sample-app', async () => {
    await analyze('sample-app');
    await p.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    const pill = await p.locator('#header-source-pill').innerText();
    if (!pill.includes('LIVE PROJECT') || !pill.includes('GITHUB REPOSITORY')) throw new Error(pill);
  });
  await p.waitForTimeout(400);
  await shot('04-overview');

  await step('overview uses real data', async () => {
    const t = await p.locator('#page-overview').innerText();
    for (const s of ['octo-dev/sample-app', 'Files Reached by Tests', 'API routes: 4', 'Modules', 'Module Test Reach', 'Express.js', 'a1b2c3d']) if (!t.includes(s)) throw new Error('missing ' + s);
    for (const bad of ['ShopCore', 'Express 4.18', '127 passed', 'Authentication', '35 findings']) if (t.includes(bad)) throw new Error('demo data leaked: ' + bad);
  });
  await step('maintenance findings', async () => {
    await p.evaluate(() => navigate('maintenance'));
    const t = await p.locator('#maintenance-findings').innerText();
    for (const s of ['environment variables used in code but not documented', 'express@4.17.1', 'CI never runs the test suite', 'unpinned base image']) if (!t.includes(s)) throw new Error('missing ' + s);
    if (t.includes('lodash@')) throw new Error('lodash ^4.17.21 wrongly flagged');
  });
  await shot('05-maintenance');
  await step('project map + module detail', async () => {
    await p.evaluate(() => navigate('map'));
    if (await p.locator('#project-map-svg .map-node').count() !== 5) throw new Error('nodes');
    if (await p.locator('#project-map-svg line').count() !== 3) throw new Error('edges');
    await p.locator('#mn-src\\/services').click();
    const t = await p.locator('#map-detail-content').textContent();
    if (!t.includes('src/services/billing.ts') || !t.includes('Used By')) throw new Error(t.slice(0, 200));
  });
  await shot('06-map');
  await step('testing tabs', async () => {
    await p.evaluate(() => navigate('testing'));
    const cov = await p.locator('#coverage-by-module').innerText();
    if (!cov.includes('Test Reach by Module') || cov.includes('not publicly accessible')) throw new Error(cov.slice(0, 200));
    const gaps = await p.locator('#testing-gaps').textContent();
    if (!gaps.includes('src/services/billing.ts') || !gaps.includes('POST /billing/charge')) throw new Error('GAPS: ' + gaps.replace(/\s+/g, ' ').slice(0, 300));
    const res = await p.locator('#test-results-panel').textContent();
    if (!res.includes('tests/users.test.ts') || !res.includes('npm test')) throw new Error('RES:' + res.slice(0, 600));
  });
  await step('generate test stub from real exports', async () => {
    await p.evaluate(() => openGenModal('src/services'));
    const t = await p.locator('#gen-modal-body').innerText();
    if (!t.includes("import { charge, Invoice } from '../../src/services/billing';") || !t.includes('tests/services/billing.test.ts')) throw new Error(t);
  });
  await shot('07-generate');
  await p.evaluate(() => closeModal('gen-modal'));
  await step('change impact', async () => {
    await p.evaluate(() => navigate('impact'));
    await p.locator('#impact-component-buttons button[data-id="src/services"]').click();
    const t = await p.locator('#impact-result-content').innerText();
    for (const s of ['src/routes/billing.ts', 'src/app.ts', 'tests/users.test.ts', 'POST /billing/charge', 'No test reaches']) if (!t.includes(s)) throw new Error('missing ' + s);
  });
  await shot('08-impact');
  await step('onboarding', async () => {
    await p.evaluate(() => navigate('onboarding'));
    const tabs = p.locator('#page-onboarding .tab');
    const all = [];
    for (let i = 0; i < await tabs.count(); i++) { await tabs.nth(i).click(); all.push(await p.locator('#page-onboarding').innerText()); }
    const t = all.join('\n');
    for (const s of ['POST /billing/charge', 'npm ci', 'DATABASE_URL', 'src/index.ts']) if (!t.includes(s)) throw new Error('missing ' + s);
  });
  await step('release + reports', async () => {
    await p.evaluate(() => navigate('release'));
    await p.evaluate(() => prepareRelease());
    await p.waitForTimeout(6000);
    await p.evaluate(() => { showReport('health'); closeModal('report-modal'); showReport('release'); closeModal('report-modal'); showReport('summary'); });
    const t = await p.locator('#report-modal-body').innerText();
    if (!t.includes('sample-app')) throw new Error(t.slice(0, 200));
    await p.evaluate(() => closeModal('report-modal'));
  });
  await step('run tests does not simulate for real repos', async () => {
    await p.evaluate(() => runTests());
    const t = await p.locator('#toast').innerText();
    if (!t.includes('npm test') || t.includes('127')) throw new Error(t);
  });

  await step('hostile repository content is never executed', async () => {
    for (const pg of ['overview','map','onboarding','maintenance','testing','impact','release','reports']) {
      await p.evaluate(x => navigate(x), pg);
      await p.waitForTimeout(150);
    }
    const tabs = p.locator('#page-onboarding .tab');
    await p.evaluate(() => navigate('onboarding'));
    for (let i = 0; i < await tabs.count(); i++) await tabs.nth(i).click();
    await p.evaluate(() => navigate('testing'));
    const ttabs = p.locator('#page-testing .tab');
    for (let i = 0; i < await ttabs.count(); i++) await ttabs.nth(i).click();
    await p.evaluate(() => { navigate('impact'); (activeUrlProfile._repoData.modules || []).forEach(x => selectImpactComponent(x.id)); navigate('map'); (activeUrlProfile.mapNodes || []).forEach(n => selectMapNode(n.id)); });
    await p.evaluate(() => { showReport('health'); showReport('release'); showReport('summary'); closeModal('report-modal'); });
    await p.evaluate(() => { (activeUrlProfile._repoData.modules || []).forEach(x => openGenModal(x.id)); closeModal('gen-modal'); });
    await p.waitForTimeout(500);
    const x = await p.evaluate(() => window.__xss);
    if (x !== undefined) throw new Error('XSS executed: ' + x);
    if (process.env.TRACEON_XSS_FIXTURE && !(await p.locator('#page-overview').textContent()).includes('<img src=x onerror=window.__xss=4>')) {
      await p.evaluate(() => navigate('overview'));
      if (!(await p.locator('#page-overview').textContent()).includes('onerror=window.__xss=4')) throw new Error('description not shown as text');
    }
  });

  await step('switch project → still signed in → sign out', async () => {
    await p.evaluate(() => showConnect());
    await p.click('#gh-continue-btn');
    await p.waitForSelector('#cs-gh-connected:has-text("Signed in")');
    await p.click('button:has-text("Sign out")');
    await p.waitForSelector('#cs-landing-notice:has-text("signed out")');
    const s = await p.evaluate(() => fetch('/api/session').then(r => r.json()));
    if (s.authenticated) throw new Error('still authenticated');
  });

  await step('demo project still works and is labelled', async () => {
    await p.click('button:has-text("Try Demo Project")');
    await p.waitForTimeout(6500);
    const pill = await p.locator('#header-source-pill').innerText();
    if (!pill.includes('DEMO PROJECT')) throw new Error(pill);
    await p.evaluate(() => navigate('developer-impact'));
    if (!(await p.locator('#page-developer-impact').innerText()).includes('DEMO MEASUREMENTS')) throw new Error('label');
    await p.evaluate(() => navigate('maintenance'));
    const mt = await p.locator('#maintenance-findings').textContent();
    if (!mt.includes('jsonwebtoken') || mt.includes('sample-app') || mt.includes('STRIPE_SECRET_KEY')) throw new Error('demo maintenance shows wrong project');
    const ov = await p.evaluate(() => { navigate('overview'); return document.getElementById('page-overview').textContent; });
    if (!ov.includes('Express 4.18') || ov.includes('Module Test Reach') || ov.includes('octo-dev')) throw new Error('demo overview not restored');
    await p.evaluate(() => navigate('impact'));
    if (!(await p.locator('#impact-component-buttons').textContent()).includes('Payments')) throw new Error('demo impact not restored');
  });
  await shot('09-demo');

  // Opened as a plain file: honest "server required" state, no fake login
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => errs.push('file pageerror: ' + e.message));
  await p2.goto('file://' + R + '/traceon.html');
  await step('file:// shows setup-required instead of fake login', async () => {
    await p2.click('#gh-continue-btn');
    await p2.waitForSelector('#cs-github-auth-body:has-text("GitHub sign-in is not available yet")');
    if (await p2.locator('#cs-github-auth-body input').count()) throw new Error('input present');
  });
  await p2.screenshot({ path: `${SP}/10-file-mode.png` });

  const real = errs.filter(e => !/Failed to load resource/.test(e));
  console.log(real.length ? 'ERRORS:\n' + real.join('\n') : 'NO ERRORS');
  console.log('GitHub write requests:', gh.state.writes.length);
  await b.close(); server.close(); await gh.close();
  process.exit(real.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
