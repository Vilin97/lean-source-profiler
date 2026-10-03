#!/usr/bin/env node
'use strict';

// Run after `npm run build`. Tests actual Lean capture once and uses a tiny fake
// Lake executable for deterministic collection failure/cancellation checks.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureSession, discoverLeanFiles, readSession, readSessionProfile, readIndex } = require('../out/collection.js');
const { queryRows } = require('../out/query.js');

const extensionRoot = path.resolve(__dirname, '..');
const results = path.join(__dirname, 'results');
const report = { startedAt: new Date().toISOString(), checks: [], captures: [] };
let scratch;

async function check(name, fn) {
  console.log(`RUN ${name}`);
  const start = performance.now();
  try { await fn(); report.checks.push({ name, passed: true, wallMs: performance.now() - start }); }
  catch (error) { report.checks.push({ name, passed: false, wallMs: performance.now() - start, error: error.stack || String(error) }); }
}
async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { flag: 'wx' });
}
function checkpointFrom(directory) {
  for (const file of syncFs.readdirSync(directory).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(syncFs.readFileSync(path.join(directory, file), 'utf8'));
    if (data.kind === 'lean-source-profile-session') return data;
  }
  return undefined;
}
function near(actual, expected, message) { assert(Math.abs(actual - expected) < 0.00001, `${message}: ${actual} vs ${expected}`); }

(async () => {
  await fs.mkdir(results, { recursive: true });
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lean collection tests ')));
  const project = path.join(scratch, 'project with spaces');
  const valid = path.join(project, 'Valid');
  const partial = path.join(project, 'Partial');
  const outputs = path.join(scratch, 'recordings');
  const alphaText = 'theorem collection_alpha (n : Nat) : n = n := by\n  exact Eq.refl n\n';
  const betaText = 'theorem collection_beta : True ∧ True := by\n  constructor\n  · exact True.intro\n  · exact True.intro\n';
  const fakeText = 'theorem collection_fake : True := by\n  trivial\n';
  await write(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.34.0-rc2\n');
  await write(path.join(project, 'lakefile.toml'), 'name = "collection-fixtures"\nversion = "0.1.0"\n');
  await write(path.join(valid, 'Alpha.lean'), alphaText);
  await write(path.join(valid, 'nested', 'Beta.lean'), betaText);
  await write(path.join(valid, 'README.txt'), 'Not a Lean module.\n');
  for (const directory of ['.hidden', '.lake', 'node_modules', 'vendor', 'build', 'dist']) {
    await write(path.join(valid, directory, 'MustNotRun.lean'), 'this is deliberately not Lean\n');
  }
  const outside = path.join(scratch, 'outside');
  await write(path.join(outside, 'MustNotFollow.lean'), 'not Lean either\n');
  await fs.symlink(outside, path.join(valid, 'linked-directory'), 'dir');
  await fs.symlink(path.join(valid, 'Alpha.lean'), path.join(valid, 'Linked.lean'), 'file');
  await write(path.join(partial, 'Alpha.lean'), fakeText);
  await write(path.join(partial, 'Broken.lean'), fakeText);
  await write(path.join(partial, 'nested', 'Beta.lean'), fakeText);

  const fakeLake = path.join(scratch, 'fake-lake.cjs');
  const fakeCalls = fakeLake + '.calls';
  await write(fakeLake, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--githash')) { console.log('collection-test-' + process.pid); process.exit(0); }
if (process.argv.includes('--print-prefix')) { console.log(${JSON.stringify(scratch)}); process.exit(0); }
if (process.argv[2] === 'env') {
  if (process.argv[3] === 'lean') fs.writeFileSync(process.argv[process.argv.indexOf('-c') + 1], 'test C placeholder');
  if (process.argv[3] === 'leanc') {
    const binary = process.argv[process.argv.indexOf('-o') + 1];
    fs.copyFileSync(__filename, binary); fs.chmodSync(binary, 0o755);
  }
  process.exit(0);
}
const sourceFile = process.argv.at(-4), output = process.argv.at(-3);
const basename = path.basename(sourceFile);
fs.appendFileSync(${JSON.stringify(fakeCalls)}, sourceFile + '\\n');
if (basename === 'Broken.lean') { process.stderr.write('Intentional fixture elaboration failure\\n'); process.exit(3); }
const sourceText = fs.readFileSync(sourceFile, 'utf8');
fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, sourceFile, sourceText,
  leanVersion: '4.34.0-rc2', elapsedMs: basename === 'Alpha.lean' ? 11 : 17,
  nodes: [{ id: '0', parentId: null, category: 'Source.tactic', label: 'Source.tactic', detail: 'trivial',
    startMs: 1, durationMs: 3, sourceKind: 'exact', source: { file: sourceFile,
      start: { line: 1, character: 2 }, end: { line: 1, character: sourceText.split('\\n')[1].length } } }]
}));
`);
  await fs.chmod(fakeLake, 0o755);

  await check('directory discovery is sorted, excludes generated/vendor trees, and follows no symlinks', async () => {
    const found = await discoverLeanFiles(valid);
    assert.equal(found.projectRoot, project);
    assert.equal(found.target, valid);
    assert.deepEqual(found.files, [path.join(valid, 'Alpha.lean'), path.join(valid, 'nested', 'Beta.lean')]);
    assert(Array.isArray(found.excluded));
    const single = await discoverLeanFiles(path.join(valid, 'Alpha.lean'));
    assert.deepEqual(single.files, [path.join(valid, 'Alpha.lean')]);
    await assert.rejects(discoverLeanFiles(path.join(valid, 'README.txt')));
    await assert.rejects(discoverLeanFiles(path.join(valid, 'does-not-exist')));
  });

  let actualSession;
  await check('actual multi-file Lean capture completes and checkpoints before progress', async () => {
    const output = path.join(outputs, 'actual');
    const progress = [];
    actualSession = await captureSession({ target: valid, extensionRoot, output, thresholdMs: 0,
      onProgress: event => progress.push({ ...event, checkpoint: checkpointFrom(output) }) });
    assert.equal(actualSession.schemaVersion, 2);
    assert.equal(actualSession.kind, 'lean-source-profile-session');
    assert.equal(actualSession.status, 'complete',JSON.stringify(actualSession.files));
    assert.equal(actualSession.plannedFileCount, 2);
    assert.equal(actualSession.files.length, 2);
    assert(actualSession.files.every(file => file.status === 'ok'));
    assert.equal(new Set(actualSession.files.map(file => file.id)).size, 2);
    assert.deepEqual(progress.map(x => x.completed), [1, 2]);
    for (const event of progress) {
      assert.equal(event.total, 2);
      assert.equal(event.status, 'ok');
      assert(event.checkpoint, 'manifest exists before progress callback');
      assert.equal(event.checkpoint.files.length, event.completed);
    }
    for (const file of actualSession.files) {
      const profile = await readSessionProfile(actualSession, file.id);
      assert.equal(profile.sourceFile, file.sourceFile);
      assert.equal(profile.leanVersion, '4.34.0-rc2');
      assert(profile.nodes.some(n => n.category === 'Source.tactic'));
      assert.equal(profile.sourceText, await fs.readFile(profile.sourceFile, 'utf8'));
    }
    const fromDirectory = await readSession(output);
    const fromManifest = await readSession(actualSession.sessionPath);
    assert.deepEqual(fromDirectory.files, actualSession.files);
    assert.deepEqual(fromManifest.files, actualSession.files);
    await assert.rejects(readSessionProfile(actualSession, 'missing-file-id'));
    report.captures.push({ label: 'actual two Lean files', status: actualSession.status, wallMs: actualSession.wallMs,
      files: actualSession.files.map(x => ({ path: x.path, elapsedMs: x.elapsedMs, eventCount: x.eventCount })) });
  });

  await check('query index faithfully preserves file/declaration/tactic times and one-based source lines', async () => {
    assert(actualSession, 'actual capture available');
    const rows = await readIndex(actualSession);
    assert(rows.length > 0);
    for (const row of rows) {
      assert(Number.isFinite(row.durationMs) && row.durationMs >= 0);
      assert(!path.isAbsolute(row.path), 'query paths are project-relative');
      assert(!row.path.includes('\\'), 'query paths are POSIX');
      if (row.line !== undefined) assert(Number.isInteger(row.line) && row.line >= 1);
    }
    const fileRows = queryRows(rows, { kind: 'file', limit: 100 });
    assert.equal(fileRows.length, 2);
    for (const file of actualSession.files) {
      const row = fileRows.find(row => row.path === file.path);
      assert(row); near(row.durationMs, file.elapsedMs, 'file elapsed time');
      const profile = await readSessionProfile(actualSession, file.id);
      for (const row of rows.filter(row => row.kind === 'tactic' && row.path === file.path)) {
        const node = profile.nodes.find(n => n.id === row.eventId);
        assert(node, 'tactic query row resolves to actual profile event');
        near(row.durationMs, node.durationMs, 'tactic inclusive time');
        if (row.selfMs !== undefined) near(row.selfMs, node.selfMs, 'tactic self time');
        assert.equal(row.line, node.source.start.line + 1);
      }
    }
    assert(rows.some(row => row.kind === 'tactic' && row.path === 'Valid/Alpha.lean' && row.line === 2));
    assert(rows.some(row => row.kind === 'declaration' && row.name.includes('collection_alpha')));
    assert(rows.some(row => row.kind === 'declaration' && row.name.includes('collection_beta')));
    const total = fileRows.reduce((sum, row) => sum + row.durationMs, 0);
    const folder = rows.find(row => row.kind === 'folder' && row.path === 'Valid');
    assert(folder); near(folder.durationMs, total, 'folder is sum of files once, excluding declaration/tactic duplicates');
    const nested = rows.find(row => row.kind === 'folder' && row.path === 'Valid/nested');
    assert(nested); near(nested.durationMs, fileRows.find(row => row.path === 'Valid/nested/Beta.lean').durationMs, 'nested folder sum');
  });

  await check('legacy single-file recordings can be opened as a collection', async () => {
    assert(actualSession);
    const profile = await readSessionProfile(actualSession, actualSession.files[0].id);
    const legacy = await readSession(profile.profilePath);
    assert.equal(legacy.files.length, 1);
    assert.equal(legacy.files[0].status, 'ok');
    const reopened = await readSessionProfile(legacy, legacy.files[0].id);
    assert.equal(reopened.sourceText, profile.sourceText);
    assert.equal(reopened.nodes.length, profile.nodes.length);
    assert((await readIndex(legacy)).some(row => row.kind === 'file'));
  });

  await check('a file failure is recorded and later files still run sequentially', async () => {
    const progress = [];
    const session = await captureSession({ target: partial, extensionRoot, output: path.join(outputs, 'partial'), lakePath: fakeLake,
      onProgress: event => progress.push(event) });
    assert.equal(session.status, 'partial');
    assert.equal(session.plannedFileCount, 3);
    assert.deepEqual(session.files.map(x => x.status), ['ok', 'error', 'ok']);
    assert(session.files[1].error.includes('Intentional fixture elaboration failure'));
    assert.deepEqual(progress.map(x => x.completed), [1, 2, 3]);
    assert.deepEqual(progress.map(x => x.status), ['ok', 'error', 'ok']);
    const rows = await readIndex(session);
    const fileRows = queryRows(rows, { kind: 'file', limit: 100 });
    assert.equal(fileRows.length, 2, 'failed files have no invented duration');
    assert.deepEqual(fileRows.map(x => x.durationMs), [17, 11]);
    const folder = rows.find(row => row.kind === 'folder' && row.path === 'Partial');
    assert(folder); near(folder.durationMs, 28, 'partial folder totals successful files only');
    report.captures.push({ label: 'synthetic partial failure', status: session.status, files: session.files.map(x => ({ path: x.path, status: x.status })) });
  });

  await check('cancellation preserves the checkpoint and completed profile without starting the next file', async () => {
    const controller = new AbortController();
    const output = path.join(outputs, 'cancelled');
    const before = (await fs.readFile(fakeCalls, 'utf8')).trim().split('\n').length;
    const session = await captureSession({ target: valid, extensionRoot, output, lakePath: fakeLake, signal: controller.signal,
      onProgress: event => { if (event.completed === 1) controller.abort(); } });
    assert.equal(session.status, 'cancelled');
    assert.equal(session.plannedFileCount, 2);
    assert.equal(session.files.length, 1);
    assert.equal(session.files[0].status, 'ok');
    assert.equal((await fs.readFile(fakeCalls, 'utf8')).trim().split('\n').length, before + 1);
    const saved = await readSession(output);
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.files.length, 1);
    assert((await readSessionProfile(saved, saved.files[0].id)).nodes.length > 0);
    assert.equal((await readIndex(saved)).filter(row => row.kind === 'file').length, 1);
  });

  await check('existing output directories are never overwritten or reused', async () => {
    const output = path.join(outputs, 'protected');
    const sentinel = path.join(output, 'keep.txt');
    await write(sentinel, 'keep this recording intact\n');
    const before = await fs.readFile(fakeCalls, 'utf8');
    await assert.rejects(captureSession({ target: valid, extensionRoot, output, lakePath: fakeLake }), /exist|overwrite/i);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep this recording intact\n');
    assert.equal(await fs.readFile(fakeCalls, 'utf8'), before, 'no capture process started');
  });

  await check('malformed or unsupported session JSON rejects clearly', async () => {
    const malformed = path.join(scratch, 'malformed.json');
    const unknown = path.join(scratch, 'unknown.json');
    await write(malformed, '{ broken JSON');
    await write(unknown, JSON.stringify({ schemaVersion: 999, kind: 'lean-source-profile-session' }));
    await assert.rejects(readSession(malformed));
    await assert.rejects(readSession(unknown));
  });

  await check('manifest paths cannot escape through traversal or symlinks', async () => {
    assert(actualSession);
    const directory = path.join(scratch, 'malicious-session');
    const manifest = path.join(directory, 'session.json');
    const entry = { ...actualSession.files[0] };
    const base = { ...actualSession, files: [entry], plannedFileCount: 1 };
    await write(manifest, JSON.stringify({ ...base, files: [{ ...entry, profile: '../outside.json' }] }));
    await assert.rejects(readSession(manifest), /relative|manifest|path/i);
    await fs.writeFile(manifest, JSON.stringify({ ...base, files: [{ ...entry, profile: 'linked.leanprofile.json' }] }));
    const sourceProfile = await readSessionProfile(actualSession, entry.id);
    await fs.symlink(sourceProfile.profilePath, path.join(directory, 'linked.leanprofile.json'), 'file');
    const imported = await readSession(manifest);
    await assert.rejects(readSessionProfile(imported, entry.id), /escape/i);
    await fs.writeFile(manifest, JSON.stringify({ ...base, files: [entry, entry], plannedFileCount: 2 }));
    await assert.rejects(readSession(manifest), /manifest/i);
  });

  await check('imported query indexes reject malformed navigation metadata', async () => {
    assert(actualSession);
    const directory = path.join(scratch, 'invalid-index');
    await fs.mkdir(directory);
    const index = path.join(directory, 'index.jsonl');
    const session = { ...actualSession, sessionPath: path.join(directory, 'session.json') };
    const validRow = { kind: 'tactic', name: 'exact proof', path: 'Valid/Alpha.lean', durationMs: 1, line: 2, endLine: 2, eventId: '0' };
    for (const invalid of [
      { line: -1 }, { line: 1.5 }, { line: '2' }, { endLine: 0 }, { endLine: 1 },
      { eventId: 123 }, { declaration: 123 }
    ]) {
      await fs.writeFile(index, JSON.stringify({ ...validRow, ...invalid }) + '\n');
      await assert.rejects(readIndex(session), undefined, JSON.stringify(invalid));
    }
  });

  await check('an index ahead of the manifest exposes only committed files and recomputes folder totals', async () => {
    assert(actualSession);
    const directory = path.join(scratch, 'interrupted-checkpoint');
    await fs.mkdir(directory);
    const manifest = path.join(directory, 'session.json');
    const committed = { ...actualSession, status: 'partial', files: [actualSession.files[0]], sessionPath: manifest };
    await fs.writeFile(manifest, JSON.stringify(committed));
    const allRows = await readIndex(actualSession);
    await fs.writeFile(path.join(directory, 'index.jsonl'), allRows.map(row => JSON.stringify(
      row.kind === 'folder' ? { ...row, durationMs: 999999 } : row)).join('\n') + '\n');
    const loaded = await readSession(manifest);
    const visible = await readIndex(loaded);
    assert.equal(visible.filter(row => row.kind === 'file').length, 1);
    assert(visible.filter(row => row.kind !== 'folder').every(row => row.path === committed.files[0].path));
    near(visible.find(row => row.kind === 'folder' && row.path === 'Valid').durationMs,
      committed.files[0].elapsedMs, 'recomputed committed folder total');
  });

  await check('index symlinks cannot escape the recording directory', async () => {
    assert(actualSession);
    const directory = path.join(scratch, 'escaping-index');
    await fs.mkdir(directory);
    await fs.symlink(path.join(path.dirname(actualSession.sessionPath), 'index.jsonl'), path.join(directory, 'index.jsonl'), 'file');
    await assert.rejects(readIndex({ ...actualSession, sessionPath: path.join(directory, 'session.json') }), /escape/i);
  });

  await check('an interrupted final index append preserves committed rows; complete corrupt indexes fail', async () => {
    const directory=path.join(scratch,'truncated-index');
    await fs.mkdir(directory);
    const session={...actualSession,sessionPath:path.join(directory,'session.json'),status:'partial'};
    const rows=await readIndex(actualSession);
    const prefix=rows.map(row=>JSON.stringify(row)).join('\n');
    const index=path.join(directory,'index.jsonl');
    await fs.writeFile(index,prefix);
    assert.deepEqual(await readIndex(session),rows,'valid last row without newline remains readable');
    await fs.writeFile(index,prefix+'\n{"kind":"file","name":');
    assert.deepEqual(await readIndex(session),rows,'only the unfinished suffix is ignored');
    await assert.rejects(readIndex({...session,status:'complete'}));
    await fs.writeFile(index,'{ broken }\n'+prefix+'\n');
    await assert.rejects(readIndex(session),'completed malformed rows cannot be ignored');
  });
})().catch(error => {
  report.checks.push({ name: 'collection test setup completed', passed: false, error: error.stack || String(error) });
}).finally(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  report.completedAt = new Date().toISOString();
  report.summary = { passed: report.checks.filter(x => x.passed).length, failed: report.checks.filter(x => !x.passed).length };
  report.passed = report.summary.failed === 0;
  await fs.mkdir(results, { recursive: true });
  await fs.writeFile(path.join(results, 'collection.json'), JSON.stringify(report, null, 2) + '\n');
  for (const item of report.checks) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name}${item.error ? '\n' + item.error : ''}`);
  console.log(`Report: ${path.join(results, 'collection.json')}`);
  process.exitCode = report.passed ? 0 : 1;
});
