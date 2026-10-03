'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const cli = path.resolve(__dirname, '..', 'out', 'cli.js');

async function withFixture(fn) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lean-cli-test-')));
  try {
    const project = path.join(directory, 'project');
    const sourceFile = path.join(project, 'Dir', 'Sample.lean');
    const sourceText = 'theorem proof : True := by\n  exact True.intro\n';
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, sourceText);
    const full = { file: sourceFile, start: { line: 0, character: 0 }, end: { line: 1, character: 18 } };
    const tactic = { file: sourceFile, start: { line: 1, character: 2 }, end: { line: 1, character: 18 } };
    const recording = path.join(directory, 'fixture.leanprofile.json');
    await fs.writeFile(recording, JSON.stringify({ schemaVersion: 1, sourceFile, sourceText, projectRoot: project,
      leanVersion: 'test', elapsedMs: 20, declarations: [{ name: 'Demo.proof', source: full }], nodes: [
        { id: '0', parentId: null, category: 'Elab.command', label: 'theorem proof', detail: '', startMs: 0, durationMs: 12, source: full, sourceKind: 'exact' },
        { id: '1', parentId: '0', category: 'Source.tactic', label: 'Source.tactic: Lean.Parser.Tactic.exact', detail: 'exact True.intro', startMs: 2, durationMs: 7, source: tactic, sourceKind: 'exact' }
      ] }));
    return await fn({ directory, project, sourceFile, recording });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI test exceeded 10 seconds')); }, 10000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

test('CLI JSON and JSONL query output is machine-readable for every row kind', async () => withFixture(async ({ recording }) => {
  for (const kind of ['file', 'folder', 'declaration', 'tactic']) {
    const json = await run(['query', recording, '--kind', kind, '--json']);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, '', 'JSON metadata and rows belong exclusively to stdout');
    const document = JSON.parse(json.stdout);
    assert.equal(document.status, 'complete');
    assert.equal(document.completedFiles, 1);
    assert.equal(document.failedFiles, 0);
    assert.equal(document.plannedFiles, 1);
    assert(document.results.length > 0);
    assert(document.results.every(row => row.kind === kind));

    const jsonl = await run(['query', recording, '--kind', kind, '--jsonl']);
    assert.equal(jsonl.code, 0, jsonl.stderr);
    const lines = jsonl.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines, document.results);
    const metadata = JSON.parse(jsonl.stderr);
    assert.equal(metadata.status, 'complete');
    assert.equal(metadata.completedFiles, 1);
    assert(!('results' in metadata), 'JSONL metadata is separate from row records');
  }
  const all = JSON.parse((await run(['query', recording, '--json'])).stdout);
  assert.deepEqual(new Set(all.results.map(row => row.kind)), new Set(['file', 'folder', 'declaration', 'tactic']));
  assert.equal(all.results.find(row => row.kind === 'file').durationMs, 20);
  assert.equal(all.results.find(row => row.kind === 'declaration').durationMs, 12);
  assert.equal(all.results.find(row => row.kind === 'tactic').durationMs, 7);
  assert.equal(all.results.find(row => row.kind === 'tactic').line, 2);
}));

test('CLI invalid query arguments exit 1 without contaminating machine stdout', async () => withFixture(async ({ recording }) => {
  for (const args of [
    ['--json', '--jsonl'], ['--kind', 'unknown'], ['--limit', '0'], ['--sort', 'startMs'],
    ['--path', '../outside'], ['--unknown'], ['--limit']
  ]) {
    const result = await run(['query', recording, ...args]);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.stdout, '', JSON.stringify(args));
    assert(result.stderr.length > 0, 'error is reported on stderr');
  }
}));

test('CLI SIGTERM exits 143, saves a cancelled session, and terminates its capture child',
  { timeout: 15000, skip: process.platform === 'win32' }, async () => withFixture(async ({ directory, project }) => {
    await fs.writeFile(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.34.0-rc2\n');
    await fs.writeFile(path.join(project, 'lakefile.toml'), 'name = "cli-cancellation-test"\n');
    const fakeLake = path.join(directory, 'blocking-lake.cjs');
    const pidFile = path.join(directory, 'capture-child.pid');
    await fs.writeFile(fakeLake, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--githash')) { console.log('cli-cancellation-fixture'); process.exit(0); }
if (process.argv.includes('--print-prefix')) { console.log(${JSON.stringify(directory)}); process.exit(0); }
if (process.argv.length === 3 && process.argv[2] === 'env') process.exit(0);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write('CLI_CAPTURE_CHILD_READY:' + process.pid + '\\n');
setInterval(() => {}, 1000);
`);
    await fs.chmod(fakeLake, 0o755);
    const output = path.join(directory, 'cancelled-session');
    const child = spawn(process.execPath, [cli, 'profile', project, '--lake', fakeLake, '--output', output],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', capturePid;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const readyTimeout = setTimeout(() => rejectReady(new Error('Capture child never signalled readiness')), 5000);
    const finished = new Promise((resolve, reject) => {
      child.on('error', error => { rejectReady(error); reject(error); });
      child.on('close', (code, signal) => {
        if (!capturePid) rejectReady(new Error(`CLI exited before capture child started: ${code}\n${stderr}`));
        resolve({ code, signal });
      });
    });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/CLI_CAPTURE_CHILD_READY:(\d+)/);
      if (match && !capturePid) { capturePid = Number(match[1]); clearTimeout(readyTimeout); resolveReady(); }
    });
    try {
      await ready;
      assert.equal(capturePid, Number(await fs.readFile(pidFile, 'utf8')), 'PID is from this test-owned capture process');
      assert.notEqual(capturePid, child.pid);
      child.kill('SIGTERM');
      const finishTimeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      let exit;
      try { exit = await finished; } finally { clearTimeout(finishTimeout); }
      assert.equal(exit.code, 143, stderr);
      assert.equal(exit.signal, null, 'CLI handles SIGTERM and sets its exit status');
      const manifestPath = stdout.trim();
      assert.equal(manifestPath, path.join(output, 'session.json'));
      const session = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      assert.equal(session.status, 'cancelled');
      assert.equal(session.plannedFileCount, 1);
      assert.equal(session.files.length, 0, 'active cancelled file is not falsely reported as a completed failure');
      assert.throws(() => process.kill(capturePid, 0), error => error.code === 'ESRCH', 'capture subprocess is gone');
    } finally {
      clearTimeout(readyTimeout);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (capturePid) { try { process.kill(capturePid, 'SIGKILL'); } catch { /* already exited */ } }
    }
  }));
