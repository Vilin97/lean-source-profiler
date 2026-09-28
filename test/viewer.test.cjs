const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { intervalUnion, sourceLineTimings, folderTotals, folderChildren, aggregateOperations, percent, apiRoute } = require('../media/viewer.js');
const { startViewer, renderViewerHtml } = require('../out/viewer.js');

const source = (line, endLine = line) => ({ file: '/repo/Main.lean', start: { line, character: 2 }, end: { line: endLine, character: 12 } });
const node = (id, startMs, durationMs, extra = {}) => ({ id, parentId: null, category: 'Source.tactic', label: 'Source.tactic: Lean.Parser.Tactic.exact', detail: 'exact proof', startMs, durationMs, selfMs: 0, sourceKind: 'exact', source: source(1), ...extra });

test('browser timing bars use interval unions and preserve macro-origin tactics', () => {
  assert.equal(intervalUnion([[0, 10], [3, 8], [7, 12], [20, 25]]), 17);
  const bars = sourceLineTimings([
    node('sequence', 0, 105, { label: 'Source.tactic: Lean.Parser.Tactic.tacticSeq1Indented', source: source(1, 2) }),
    node('funext', 0, 1, { label: 'Source.tactic: Lean.Parser.Tactic.seq1' }),
    node('exact', 2, 100, { source: source(2) }),
    node('inner', 3, 90, { source: source(2), parentId: 'exact' }),
    node('whnf', 3, 900, { category: 'Meta.whnf', sourceKind: 'inherited' }),
    node('argument', 3, 80, { category: 'Source.term', source: source(2) }),
    node('command', 0, 999, { category: 'Elab.command', source: source(1, 2) }),
  ], '/repo/Main.lean');
  assert.deepEqual(bars.map(row => [row.line, row.durationMs, row.nodeId]), [[1, 1, 'funext'], [2, 100, 'exact']]);
  assert.equal(sourceLineTimings([node('other', 0, 12)], '/repo/Other.lean').length, 0);
});

test('repository folder totals include successful descendants and exclude failed files', () => {
  const files = [
    { id: '0', path: 'NS/A.lean', status: 'ok', elapsedMs: 50 },
    { id: '1', path: 'NS/Sub/B.lean', status: 'ok', elapsedMs: 30 },
    { id: '2', path: 'NS/Sub/Failed.lean', status: 'error', error: 'failed' },
    { id: '3', path: 'NSExtra/C.lean', status: 'ok', elapsedMs: 20 },
    { id: '4', path: 'Root.lean', status: 'ok', elapsedMs: 10 },
  ];
  assert.deepEqual(folderTotals(files, 'NS'), { count: 3, captured: 2, failed: 1, durationMs: 80 });
  assert.deepEqual(folderChildren(files).map(row => [row.name, row.durationMs]), [['NS', 80], ['NSExtra', 20], ['Root.lean', 10]]);
  assert.deepEqual(folderChildren(files, 'NS').map(row => [row.kind, row.name, row.durationMs]), [['file', 'A.lean', 50], ['folder', 'Sub', 30]]);
  assert.equal(percent(30, 80), 37.5);
  assert.equal(percent(30, 0), 0);
});

test('aggregate drill retains every contributing root without counting nested children again', () => {
  const nodes = [
    node('command', 0, 1.2, { category: 'Elab.command' }),
    node('async', 1, 1, { category: 'Elab.async' }),
    node('tactic', 1.1, .8, { parentId: 'async' }),
    node('inner', 1.2, .6, { parentId: 'tactic', category: 'Meta.whnf' }),
    node('other', 5, 10),
  ];
  const roots = aggregateOperations(nodes, ['command', 'async', 'tactic', 'inner', 'command']);
  assert.deepEqual(roots.map(root => root.id), ['command', 'async']);
  assert.equal(intervalUnion(roots.map(root => [root.startMs, root.startMs + root.durationMs])), 2);
  assert.equal(roots[0].durationMs, 1.2); // Root timings are real; no fake parent/self values are introduced.
});

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-viewer-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, 'Main.lean'), sourceText = 'example : True := by\n  trivial\n';
  await fs.writeFile(sourceFile, sourceText);
  const profile = { schemaVersion: 1, sourceFile, sourceText, projectRoot: root, leanVersion: '4.34.0-rc2', elapsedMs: 20, captureWallMs: 35, nodes: [node('root', 0, 12, { source: { file: sourceFile, start: { line: 1, character: 2 }, end: { line: 1, character: 9 } } })] };
  const recording = path.join(root, 'profile.leanprofile.json'); await fs.writeFile(recording, JSON.stringify(profile));
  return { root, profile, recording };
}

test('standalone viewer adapts one recording and serves only whitelisted loopback resources', async t => {
  const { recording, profile } = await fixture(t);
  const viewer = await startViewer(recording, { open: false });
  t.after(() => viewer.close());
  assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const page = await request(viewer.url);
  assert.equal(page.status, 200);
  assert.match(page.body, /Lean Source Profiler/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  const summary = JSON.parse((await request(`${viewer.url}api/session`)).body);
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0].elapsedMs, 20);
  assert.ok(summary.files[0].openInVSCode.startsWith('vscode://local-lean-tools.lean-source-profiler/open?file='));
  const captured = JSON.parse((await request(`${viewer.url}api/file?id=0`)).body);
  assert.equal(captured.sourceText, profile.sourceText);
  const index = JSON.parse((await request(`${viewer.url}api/index`)).body);
  assert.ok(index.some(row => row.kind === 'file' && row.durationMs === 20));
  assert.equal((await request(`${viewer.url}api/file?id=${encodeURIComponent('../profile.leanprofile.json')}`)).status, 404);
  assert.equal((await request(`${viewer.url}api/file?path=${encodeURIComponent('/etc/passwd')}`)).status, 404);
  assert.equal((await request(`${viewer.url}src/viewer.ts`)).status, 404);
  assert.equal((await request(viewer.url, { method: 'POST' })).status, 405);
  assert.equal((await request(`${viewer.url}api/session`, { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request(`${viewer.url}api/session`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.match((await request(`${viewer.url}viewer.js`)).headers['content-type'], /javascript/);
  assert.match((await request(`${viewer.url}viewer.css`)).headers['content-type'], /css/);
  await viewer.close(); await viewer.close();
});

test('viewer preserves failed files and refuses unsafe artifacts without losing the session', async t => {
  const { root, recording, profile } = await fixture(t);
  const directory = path.join(root, 'session'); await fs.mkdir(directory);
  await fs.symlink(recording, path.join(directory, 'escape.json'));
  const session = {
    schemaVersion: 2, kind: 'lean-source-profile-session', projectRoot: root, target: root,
    startedAt: '', completedAt: '', status: 'partial', wallMs: 50, plannedFileCount: 2, excluded: [],
    files: [{ id: '0', path: 'Main.lean', sourceFile: profile.sourceFile, status: 'ok', profile: 'escape.json', elapsedMs: 20 },
      { id: '1', path: 'Failed.lean', sourceFile: path.join(root, 'Failed.lean'), status: 'error', error: '<script>capture failed</script>' }],
  };
  await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify(session));
  await fs.writeFile(path.join(directory, 'index.jsonl'), '');
  const viewer = await startViewer(directory, { open: false }); t.after(() => viewer.close());
  const summary = JSON.parse((await request(`${viewer.url}api/session`)).body);
  assert.equal(summary.files[0].openInVSCode, undefined);
  assert.equal(summary.files[1].status, 'error');
  assert.equal((await request(`${viewer.url}api/file?id=1`)).status, 409);
  assert.equal((await request(`${viewer.url}api/file?id=0`)).status, 500);
});

test('viewer shell embeds no recording text or executable inline scripts', () => {
  const html = renderViewerHtml();
  assert.match(html, /<script src="\/viewer.js" defer><\/script>/);
  assert.ok(!html.includes('onclick='));
  assert.ok(!html.includes('<style>'));
});

test('published viewer works below a repository URL and does not advertise local access', () => {
  const html = renderViewerHtml({ published: true });
  assert.match(html, /data-recording-mode="static"/);
  assert.match(html, /src="\.\/viewer.js"/);
  assert.match(html, /href="\.\/viewer.css"/);
  assert.match(html, /Published recording · read-only/);
  assert.ok(!html.includes('No source leaves this laptop'));
  const base = 'https://example.org/repository/examples/leanpool/';
  for (const [route, suffix] of [['/api/session', 'session.json'], ['/api/index', 'index.json'], ['/api/file?id=12', 'files/12.json.gz']]) {
    assert.equal(new URL(apiRoute(route, true), base).href, base + 'data/' + suffix);
    assert.equal(apiRoute(route), route);
  }
  for (const route of ['/api/file?id=../secret', '/api/file?id=%2e%2e', '/api/file?id=1&path=secret', '/api/unknown']) assert.throws(() => apiRoute(route, true));
});
