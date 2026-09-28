const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { normalizeProfile } = require('../out/model.js');
const { apiRoute, sourceLineTimings } = require('../media/viewer.js');

const builder = import('../scripts/build-public-example.mjs');
const projectRoot = '/Users/publication-audit/private-work/lean-pool';
const sourceFile = `${projectRoot}/LeanPool/Example.lean`;
const dependencyFile = '/Users/publication-audit/shared-project/.lake/packages/mathlib/Mathlib/Fixture.lean';
const toolchainFile = '/Users/publication-audit/.elan/toolchains/leanprover--lean4---v4.34.0-rc2/src/lean/Init/Prelude.lean';
const externalFile = '/Users/publication-audit/private-work/Secret.lean';
const range = file => ({ file, start: { line: 1, character: 2 }, end: { line: 1, character: 9 } });
const sourceText = 'example : True := by -- 😀\n  trivial\n';

async function fixture(t, mutate = () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-public-example-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = {
    schemaVersion: 1, sourceFile, sourceText, projectRoot, leanVersion: '4.34.0-rc2', elapsedMs: 21.75,
    captureWallMs: 25.5, thresholdMs: 1, startedAt: '2026-09-27T00:00:00Z', captureMethod: 'Lean trace with source ranges',
    profilePath: '/Users/publication-audit/private-output/profile.json', diagnostics: [{ message: '/home/private/diagnostic' }],
    privateProperty: '/Users/publication-audit/private-extra',
    sourceTexts: {
      [sourceFile]: sourceText,
      [dependencyFile]: '-- Public dependency\n  trivial\n',
      [toolchainFile]: '-- Lean toolchain\n  trivial\n',
      [externalFile]: '-- Private unrelated source must not leave the laptop.\n  trivial\n',
      [`${projectRoot}/Unused.lean`]: '-- /Users/private/unreferenced snapshot\n',
    },
    declarations: [{ name: 'Example.main', source: range(sourceFile), kind: 'theorem' }],
    nodes: [
      { id: 'root', parentId: null, category: 'Source.tactic', label: 'Source.tactic: Lean.Parser.Tactic.exact', detail: 'trivial',
        startMs: 1.5, durationMs: 12.75, sourceKind: 'exact', source: range(sourceFile), selfMs: 999,
        symbols: [
          { name: 'Mathlib.public', kind: 'reference', file: dependencyFile, range: range(dependencyFile) },
          { name: 'True', kind: 'unfold', file: toolchainFile, range: range(toolchainFile) },
          { name: 'External.symbol', kind: 'reference', file: externalFile, range: range(externalFile) },
        ] },
      { id: 'child', parentId: 'root', category: 'Meta.whnf', label: 'Meta.whnf', detail: 'True',
        startMs: 2, durationMs: 7.25, sourceKind: 'inherited', source: range(sourceFile), selfMs: 999 },
    ],
  };
  mutate(profile);
  const recording = path.join(root, 'profile.json');
  await fs.writeFile(recording, JSON.stringify(profile));
  return { root, profile, recording, output: path.join(root, 'published') };
}
async function json(file) { const buffer = await fs.readFile(file); return JSON.parse(file.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8')); }

test('public export preserves source attribution and timings while removing private paths and unreferenced snapshots', async t => {
  const { buildPublicExample } = await builder;
  const { profile, recording, output } = await fixture(t);
  const raw = normalizeProfile(profile);
  const publication = { description: 'Real source example <script> is literal text.', sourceUrl: 'https://github.com/Vilin97/lean-pool/tree/pinned', licenseUrl: 'https://github.com/Vilin97/lean-pool/blob/pinned/LICENSE', privateProperty: '/Users/private/ignored' };
  const result = await buildPublicExample({ recording, output, title: 'LeanPool', provenance: publication });
  const published = await json(path.join(output, 'data/files/0.json.gz'));
  assert.equal(published.sourceFile, '/LeanPool/LeanPool/Example.lean');
  assert.equal(published.sourceText, raw.sourceText);
  assert.deepEqual(published.nodes.map(node => [node.id, node.parentId, node.startMs, node.durationMs, node.selfMs, node.source.start, node.source.end, node.sourceKind]), raw.nodes.map(node => [node.id, node.parentId, node.startMs, node.durationMs, node.selfMs, node.source.start, node.source.end, node.sourceKind]));
  assert.equal(published.elapsedMs, raw.elapsedMs);
  assert.equal(published.captureWallMs, raw.captureWallMs);
  assert.deepEqual(published.declarations[0].source.start, raw.declarations[0].source.start);
  assert.deepEqual(sourceLineTimings(published.nodes, published.sourceFile).map(row => [row.line, row.durationMs, row.nodeId]), sourceLineTimings(raw.nodes, raw.sourceFile).map(row => [row.line, row.durationMs, row.nodeId]));
  assert.equal(published.sourceTexts['/LeanPool/.lake/packages/mathlib/Mathlib/Fixture.lean'], raw.sourceTexts[dependencyFile]);
  assert.equal(published.sourceTexts['/Lean-toolchain/Init/Prelude.lean'], raw.sourceTexts[toolchainFile]);
  assert.equal(Object.keys(published.sourceTexts).length, 3);
  assert.deepEqual(published.nodes[0].symbols[2], { name: 'External.symbol', kind: 'reference', sourceStale: false });
  assert.equal(published.nodes[0].symbols[0].file, '/LeanPool/.lake/packages/mathlib/Mathlib/Fixture.lean');
  assert.equal(published.diagnostics, undefined);
  assert.equal(published.profilePath, undefined);
  assert.equal(published.privateProperty, undefined);
  normalizeProfile(published);
  const session = await json(path.join(output, 'data/session.json'));
  assert.equal(session.projectRoot, '/LeanPool');
  assert.equal(session.sessionPath, '/recording/session.json');
  assert.equal(session.files[0].openInVSCode, undefined);
  assert.equal(session.files[0].profile, 'files/0.json.gz');
  assert.equal(session.publication.privateProperty, undefined);
  assert.equal(session.publication.description, publication.description);
  assert.equal(result.files, 1);
  const inventory = await json(path.join(output, 'data/source-inventory.json'));
  assert.deepEqual(new Set(inventory.map(entry => entry.kind)), new Set(['project', 'package', 'toolchain']));
  assert.equal(inventory.find(entry => entry.kind === 'project').sha256, createHash('sha256').update(sourceText).digest('hex'));
  for (const name of ['session.json', 'index.json', 'index.jsonl', 'source-inventory.json', 'files/0.json.gz']) {
    const bytes = await fs.readFile(path.join(output, 'data', name));
    const serialized = name.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    assert.doesNotMatch(serialized, /\/Users\/|\/home\/|vscode:\/\/|private-work|private-output|Private unrelated/);
  }
  const index = await json(path.join(output, 'data/index.json'));
  const jsonl = (await fs.readFile(path.join(output, 'data/index.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(jsonl, index);
  assert.ok(index.some(row => row.kind === 'tactic' && row.durationMs === 12.75 && row.eventId === 'root'));
  await assert.rejects(buildPublicExample({ recording, output }), /already exists/);
  assert.equal(gunzipSync(await fs.readFile(path.join(output, 'data/files/0.json.gz'))).toString('utf8'), JSON.stringify(published));
  await assert.rejects(fs.stat(path.join(output, 'data/files/0.json')), { code: 'ENOENT' });
});

test('public export rejects source or event text with local paths before creating output', async t => {
  const { buildPublicExample } = await builder;
  for (const location of ['sourceText', 'detail', 'label']) {
    const { recording, output } = await fixture(t, profile => {
      if (location === 'sourceText') profile.sourceText += '-- /home/private/material\n';
      else profile.nodes[0][location] = '/Users/private/material';
    });
    await assert.rejects(buildPublicExample({ recording, output }), /privacy check failed/);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  }
});

test('public export validates provenance links and dependency publication scope', async t => {
  const { buildPublicExample } = await builder;
  const { recording, output } = await fixture(t);
  for (const url of ['javascript:alert(1)', 'file:///private/file', 'http://github.com/public', 'https://user:password@example.org/', 'https://localhost/', 'not a url']) {
    await assert.rejects(buildPublicExample({ recording, output, provenance: { sourceUrl: url } }), /publication sourceUrl|public HTTPS/);
  }
  await assert.rejects(buildPublicExample({ recording, output, title: '../escape' }), /Title/);
  const unknown = await fixture(t, profile => {
    const file = `${projectRoot}/.lake/packages/private-project/Main.lean`;
    profile.sourceTexts[file] = 'example : True := by\n  trivial\n';
    profile.nodes[0].symbols.push({ name: 'Private', kind: 'reference', file, range: range(file) });
  });
  await assert.rejects(buildPublicExample({ recording: unknown.recording, output: unknown.output }), /license\/provenance of dependency private-project/);
});

test('public session remaps nonnumeric IDs, strips arbitrary metadata, and preserves partial failure status', async t => {
  const { buildPublicExample } = await builder;
  const { root, recording, profile, output } = await fixture(t);
  const manifest = {
    schemaVersion: 2, kind: 'lean-source-profile-session', projectRoot, target: projectRoot,
    startedAt: '', completedAt: '', status: 'partial', wallMs: 44, plannedFileCount: 2,
    excluded: ['/Users/private/excluded'], unexpected: '/Users/private/metadata',
    files: [
      { id: 'arbitrary-original-id', path: 'LeanPool/Example.lean', sourceFile, status: 'ok', profile: path.basename(recording), elapsedMs: profile.elapsedMs, arbitrary: '/Users/private/filemeta' },
      { id: 'failed-original-id', path: 'LeanPool/Failed.lean', sourceFile: `${projectRoot}/LeanPool/Failed.lean`, status: 'error', error: '/Users/private/failed-diagnostics' },
    ],
  };
  await fs.writeFile(path.join(root, 'session.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, 'index.jsonl'), JSON.stringify({ kind: 'file', name: 'Example.lean', path: 'LeanPool/Example.lean', durationMs: profile.elapsedMs, arbitrary: '/home/private/indexmeta' }) + '\n');
  await buildPublicExample({ recording: path.join(root, 'session.json'), output });
  const session = await json(path.join(output, 'data/session.json'));
  assert.deepEqual(session.files.map(file => file.id), ['0', '1']);
  assert.equal(session.status, 'partial');
  assert.equal(session.plannedFileCount, 2);
  assert.equal(session.files[1].status, 'error');
  assert.match(session.files[1].error, /diagnostics are omitted/);
  assert.equal(session.files[0].arbitrary, undefined);
  assert.equal(session.unexpected, undefined);
  assert.deepEqual(session.excluded, []);
  const index = await json(path.join(output, 'data/index.json'));
  assert.equal(index.find(row => row.kind === 'file').arbitrary, undefined);
  await assert.rejects(fs.stat(path.join(output, 'data/files/1.json.gz')), { code: 'ENOENT' });
});

test('public export validates project-relative source consistency', async t => {
  const { buildPublicExample } = await builder;
  const { recording, output } = await fixture(t, profile => { profile.sourceFile = '/elsewhere/Main.lean'; });
  await assert.rejects(buildPublicExample({ recording, output }), /project-relative paths|primary source must/);
});

async function linkedFixture(t, change = () => {}) {
  const fixtureData = await fixture(t);
  const targetFile = `${projectRoot}/LeanPool/Target.lean`;
  const targetText = 'example : True := by\n  trivial\n';
  const caller = fixtureData.profile;
  caller.sourceTexts[targetFile] = targetText;
  caller.nodes[0].symbols = [{ name: 'Target.proof', file: targetFile, kind: 'reference' }];
  const target = {
    schemaVersion: 1, projectRoot, sourceFile: targetFile, sourceText: targetText, sourceTexts: { [targetFile]: targetText },
    leanVersion: '4.34.0-rc2', elapsedMs: 5, nodes: [{ ...caller.nodes[1], id: 'target-node', parentId: null, source: range(targetFile), symbols: [] }],
    declarations: [{ name: 'Target.proof', source: range(targetFile), kind: 'theorem', generated: false }],
  };
  change({ caller, target, targetFile });
  await fs.writeFile(fixtureData.recording, JSON.stringify(caller));
  await fs.writeFile(path.join(fixtureData.root, 'target.json'), JSON.stringify(target));
  const session = {
    schemaVersion: 2, kind: 'lean-source-profile-session', projectRoot, target: projectRoot,
    startedAt: '', completedAt: '', status: 'complete', wallMs: 30, plannedFileCount: 2, excluded: [],
    files: [
      { id: 'caller', path: 'LeanPool/Example.lean', sourceFile, status: 'ok', profile: path.basename(fixtureData.recording), elapsedMs: caller.elapsedMs },
      { id: 'target', path: 'LeanPool/Target.lean', sourceFile: targetFile, status: 'ok', profile: 'target.json', elapsedMs: target.elapsedMs },
    ],
  };
  const manifest = path.join(fixtureData.root, 'session.json');
  await fs.writeFile(manifest, JSON.stringify(session));
  await fs.writeFile(path.join(fixtureData.root, 'index.jsonl'), session.files.map(file => JSON.stringify({ kind: 'file', name: path.posix.basename(file.path), path: file.path, durationMs: file.elapsedMs })).join('\n') + '\n');
  return { ...fixtureData, recording: manifest, caller, target, targetFile };
}

test('cross-profile navigation joins exact semantic metadata with byte-identical imported source without moving costs', async t => {
  const { buildPublicExample } = await builder;
  const data = await linkedFixture(t);
  const before = normalizeProfile(data.caller);
  const result = await buildPublicExample(data);
  const caller = await json(path.join(data.output, 'data/files/0.json.gz'));
  assert.deepEqual(caller.nodes[0].symbols[0], { name: 'Target.proof', kind: 'reference', sourceStale: false, file: '/LeanPool/LeanPool/Target.lean', range: { start: range(data.targetFile).start, end: range(data.targetFile).end } });
  assert.equal(caller.sourceTexts['/LeanPool/LeanPool/Target.lean'], data.target.sourceText);
  assert.equal(caller.nodes.length, before.nodes.length);
  assert.deepEqual(caller.nodes.map(node => [node.id, node.parentId, node.startMs, node.durationMs, node.selfMs, node.source.start, node.source.end]), before.nodes.map(node => [node.id, node.parentId, node.startMs, node.durationMs, node.selfMs, node.source.start, node.source.end]));
  assert.equal(sourceLineTimings(caller.nodes, '/LeanPool/LeanPool/Target.lean').length, 0);
  assert.equal(result.navigationEnrichment.enrichedReferences, 1);
  const evidence = await json(path.join(data.output, 'data/navigation-provenance.json'));
  assert.equal(evidence.enrichedReferences, 1);
  assert.deepEqual(evidence.pairs, [{ fromFile: '/LeanPool/LeanPool/Example.lean', toFile: '/LeanPool/LeanPool/Target.lean', references: 1 }]);
  assert.match(evidence.note, /never assigned/);
});

test('cross-profile navigation refuses ambiguous, stale, generated, wrong-name, or mismatched-source destinations', async t => {
  const { buildPublicExample } = await builder;
  const changes = {
    ambiguous: ({ target }) => target.declarations.push({ ...target.declarations[0] }),
    stale: ({ caller }) => { caller.nodes[0].symbols[0].sourceStale = true; },
    generated: ({ target }) => { target.declarations[0].generated = true; },
    wrongName: ({ caller }) => { caller.nodes[0].symbols[0].name = 'Target.different'; },
    wrongFile: ({ caller }) => { caller.nodes[0].symbols[0].file = `${projectRoot}/LeanPool/Different.lean`; },
    mismatchedSource: ({ caller, targetFile }) => { caller.sourceTexts[targetFile] += '-- Changed after capture\n'; },
    missingSnapshot: ({ caller, targetFile }) => { delete caller.sourceTexts[targetFile]; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const data = await linkedFixture(t, change);
    const result = await buildPublicExample(data);
    const caller = await json(path.join(data.output, 'data/files/0.json.gz'));
    assert.equal(result.navigationEnrichment.enrichedReferences, 0, name);
    assert.equal(caller.nodes[0].symbols[0].range, undefined, name);
    assert.equal(caller.nodes[0].symbols[0].file, undefined, name);
  }
});

test('static export serves all viewer resources from a nested base path without an API server', async t => {
  const { buildPublicExample } = await builder;
  const { recording, output } = await fixture(t);
  await buildPublicExample({ recording, output });
  const prefix = '/repository/examples/leanpool/';
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const relative = request.url.slice(prefix.length) || 'index.html';
    if (relative.includes('..') || relative.includes('?')) { response.writeHead(404).end(); return; }
    fs.readFile(path.join(output, relative)).then(bytes => response.end(bytes), () => response.writeHead(404).end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  const html = await (await fetch(base)).text();
  assert.match(html, /data-recording-mode="static"/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /No source leaves this laptop/);
  assert.equal((await fetch(new URL('./viewer.js', base))).status, 200);
  assert.equal((await fetch(new URL('./viewer.css', base))).status, 200);
  for (const route of ['/api/session', '/api/index', '/api/file?id=0']) {
    const response = await fetch(new URL(apiRoute(route, true), base));
    assert.equal(response.status, 200);
    const object = route.startsWith('/api/file') ? JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')) : await response.json();
    assert.ok(object);
  }
  assert.equal((await fetch(new URL('/api/session', base))).status, 404);
});
