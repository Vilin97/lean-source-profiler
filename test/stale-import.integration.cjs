#!/usr/bin/env node
'use strict';

// End-to-end source freshness guard. Run after `npm run build`.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { capture, runProcess } = require('../out/capture.js');

const root = path.resolve(__dirname, '..');
const project = path.join(__dirname, 'fixtures');
const results = path.join(__dirname, 'results');
const report = { startedAt: new Date().toISOString(), checks: [], stages: [] };
const symbolName = 'SourceProfilerStaleImportFixture.payload';

function verify(name, fn) {
  try { fn(); report.checks.push({ name, passed: true }); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack || String(error) }); }
}

(async () => {
  await fs.mkdir(results, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(project, 'SourceProfileFixtures', 'StaleImportTest'));
  const relative = path.relative(project, temporary);
  const moduleName = relative.split(path.sep).join('.') + '.Imported';
  const imported = path.join(temporary, 'Imported.lean');
  const consumer = path.join(temporary, 'Consumer.lean');
  const original = 'namespace SourceProfilerStaleImportFixture\n' +
    'def payload (n : Nat) : Nat := n + 0\n' +
    'end SourceProfilerStaleImportFixture\n';
  const shifted = '\n\n' + original;
  const logs = [];

  async function buildImport() {
    await runProcess('lake', ['build', moduleName], project, undefined, text => logs.push(text));
  }
  async function record(stage, expectedStale, expectedLine) {
    console.log(`RUN stale-import ${stage}`);
    const profile = await capture({ file: consumer, extensionRoot: root, thresholdMs: 0, mode: 'detailed',
      output: path.join(results, `stale-import-${stage}.leanprofile.json`), onLog: text => logs.push(text) });
    const symbols = profile.nodes.flatMap(n => n.symbols || []).filter(s => s.name === symbolName);
    const unique = [...new Map(symbols.map(s => [JSON.stringify(s), s])).values()];
    report.stages.push({ stage, leanVersion: profile.leanVersion, captureWallMs: profile.captureWallMs,
      profilePath: profile.profilePath, symbols: unique });
    verify(`${stage}: semantic imported symbol is present`, () => assert(symbols.length > 0));
    verify(`${stage}: declaration filename remains navigable`, () => {
      assert(symbols.length > 0); assert(symbols.every(s => s.file === imported));
    });
    verify(`${stage}: source freshness status is correct`, () => {
      assert(symbols.length > 0); assert(symbols.every(s => Boolean(s.sourceStale) === expectedStale));
    });
    verify(`${stage}: ${expectedStale ? 'stale ranges are suppressed' : 'accurate declaration range is restored'}`, () => {
      assert(symbols.length > 0);
      if (expectedStale) assert(symbols.every(s => s.range === undefined), 'stale .olean source ranges must never reach the UI');
      else assert(symbols.every(s => s.range && s.range.start.line === expectedLine), `expected zero-based declaration line ${expectedLine}`);
    });
  }

  try {
    await fs.writeFile(imported, original, { flag: 'wx' });
    await fs.writeFile(consumer, `import ${moduleName}\n\n` +
      'theorem sourceProfilerStaleImportConsumer (n : Nat) :\n' +
      '    SourceProfilerStaleImportFixture.payload n = n := by\n' +
      '  exact Eq.refl n\n', { flag: 'wx' });
    await buildImport();
    await record('clean', false, 1);

    await fs.writeFile(imported, shifted);
    const compiled = path.join(project, '.lake', 'build', 'lib', 'lean', relative, 'Imported.olean');
    const sourceStat = await fs.stat(imported), compiledStat = await fs.stat(compiled);
    verify('source and .olean timestamps exercise stale branch', () => assert(sourceStat.mtimeMs > compiledStat.mtimeMs));
    await record('edited-without-build', true);

    await buildImport();
    await record('rebuilt', false, 3);

    await fs.writeFile(imported, original);
    await buildImport();
    await record('restored', false, 1);
  } catch (error) {
    report.checks.push({ name: 'stale-import workflow completed', passed: false, error: error.stack || String(error) });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    // Remove only artifacts beneath the unique module directory owned by this run.
    for (const subtree of ['lib/lean', 'ir']) {
      await fs.rm(path.join(project, '.lake', 'build', subtree, relative), { recursive: true, force: true });
    }
    await fs.writeFile(path.join(results, 'stale-import.capture.log'), logs.join(''));
  }
  report.completedAt = new Date().toISOString();
  report.summary = { passed: report.checks.filter(x => x.passed).length, failed: report.checks.filter(x => !x.passed).length };
  report.passed = report.summary.failed === 0;
  await fs.writeFile(path.join(results, 'stale-import.json'), JSON.stringify(report, null, 2) + '\n');
  for (const check of report.checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.error ? '\n' + check.error : ''}`);
  console.log(`Report: ${path.join(results, 'stale-import.json')}`);
  process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
