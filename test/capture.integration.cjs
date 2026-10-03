#!/usr/bin/env node
'use strict';

// Run after `npm run build`. Optional: NS_BENCHMARK_ROOT=/path/to/benchmark.
// `--skip-ns` runs only the portable fixture and error/cancellation checks.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { capture, readProfile, runProcess } = require('../out/capture.js');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const results = path.join(__dirname, 'results');
const benchmark = process.env.NS_BENCHMARK_ROOT || path.join(root, '..', 'ns-formalization-benchmark');
const report = { startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, checks: [], recordings: [], ns: {} };
const errors = [];

function check(name, fn) {
  try { const value = fn(); report.checks.push({ name, passed: true }); return value; }
  catch (error) { errors.push(error); report.checks.push({ name, passed: false, error: error.stack || String(error) }); }
}
async function asyncCheck(name, fn) {
  const start = performance.now();
  console.log(`RUN ${name}`);
  try { const value = await fn(); report.checks.push({ name, passed: true, elapsedMs: performance.now() - start }); return value; }
  catch (error) { errors.push(error); report.checks.push({ name, passed: false, elapsedMs: performance.now() - start, error: error.stack || String(error) }); }
}
function samePosition(a, b) { return a.line === b.line && a.character === b.character; }
function sameRange(a, b) { return a && b && samePosition(a.start, b.start) && samePosition(a.end, b.end); }
function sameSource(a, b) { return sameRange(a, b) && a.file === b.file; }
function comparePosition(a, b) { return a.line - b.line || a.character - b.character; }
function sliceRange(source, range) {
  // JS strings use UTF-16. Deliberately independent of backend byte conversion.
  const lines = source.split('\n');
  for (const point of [range.start, range.end]) {
    assert(point.line >= 0 && point.line < lines.length, 'source line in bounds');
    assert(point.character >= 0 && point.character <= lines[point.line].length, 'UTF-16 source column in bounds');
  }
  assert(comparePosition(range.start, range.end) <= 0, 'ordered source range');
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i++) offsets.push(offsets.at(-1) + lines[i].length + 1);
  return source.slice(offsets[range.start.line] + range.start.character, offsets[range.end.line] + range.end.character);
}
function exactNodes(profile, range) {
  return profile.nodes.filter(n => n.category === 'Source.tactic' && n.sourceKind === 'exact' && sameRange(n.source, range));
}
function outerNode(profile, range) {
  const matches = exactNodes(profile, range);
  assert(matches.length > 0, `exact source tactic missing for ${JSON.stringify(range)}`);
  // Registry/macro wrappers can share a syntax span. Pick outer inclusive event,
  // not a sum of wrappers around the same work.
  return matches.reduce((a, b) => a.durationMs >= b.durationMs ? a : b);
}
function descendants(profile, parentId) {
  const children = new Map();
  for (const n of profile.nodes) if (n.parentId !== null) {
    const list = children.get(n.parentId) || []; list.push(n); children.set(n.parentId, list);
  }
  const found = [], pending = [...(children.get(parentId) || [])];
  while (pending.length) { const n = pending.pop(); found.push(n); pending.push(...(children.get(n.id) || [])); }
  return found;
}
function independentlyCoveredTime(parent, children) {
  // Endpoint sweep is intentionally different from model.ts's interval merge.
  const changes = new Map();
  for (const child of children) {
    const a = Math.max(parent.startMs, child.startMs);
    const b = Math.min(parent.startMs + parent.durationMs, child.startMs + child.durationMs);
    if (b <= a) continue;
    changes.set(a, (changes.get(a) || 0) + 1); changes.set(b, (changes.get(b) || 0) - 1);
  }
  let active = 0, previous = 0, covered = 0;
  for (const [position, delta] of [...changes].sort((a, b) => a[0] - b[0])) {
    if (active > 0) covered += position - previous;
    active += delta; previous = position;
  }
  return covered;
}
function verifyIntegrity(profile, label) {
  check(`${label}: finite, bounded intervals and independently calculated self time`, () => {
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    assert.equal(byId.size, profile.nodes.length, 'unique ids');
    const children = new Map();
    for (const n of profile.nodes) {
      for (const k of ['startMs', 'durationMs', 'selfMs']) assert(Number.isFinite(n[k]) && n[k] >= 0, `${n.id}.${k}`);
      if (n.parentId !== null) {
        const parent = byId.get(n.parentId); assert(parent, 'parent resolves');
        assert(n.startMs >= parent.startMs - 0.001, `child ${n.id} starts before parent ${parent.id}`);
        assert(n.startMs + n.durationMs <= parent.startMs + parent.durationMs + 0.001,
          `child ${n.id} ends after parent ${parent.id}`);
        const list = children.get(parent.id) || []; list.push(n); children.set(parent.id, list);
      }
      if (n.source && n.source.file === profile.sourceFile) sliceRange(profile.sourceText, n.source);
    }
    for (const n of profile.nodes) {
      const expected = Math.max(0, n.durationMs - independentlyCoveredTime(n, children.get(n.id) || []));
      assert(Math.abs(n.selfMs - expected) < 0.000001, `self time ${n.id}: ${n.selfMs} vs ${expected}`);
    }
  });
  check(`${label}: inherited source attribution is backed by an ancestor`, () => {
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    let inherited = 0;
    for (const n of profile.nodes) if (n.sourceKind === 'inherited') {
      inherited++; assert(n.source, 'inherited event must have a source');
      let parent = byId.get(n.parentId), found = false;
      while (parent) {
        if (sameSource(parent.source, n.source)) { found = true; break; }
        parent = byId.get(parent.parentId);
      }
      assert(found, `event ${n.id} inherits a source no ancestor owns`);
    }
    assert(inherited > 0, 'exercise inherited internal operation attribution');
  });
  report.recordings.push({ label, sourceFile: profile.sourceFile, profilePath: profile.profilePath,
    nodes: profile.nodes.length, sourceTactics: profile.nodes.filter(n => n.category === 'Source.tactic').length,
    elapsedMs: profile.elapsedMs, captureWallMs: profile.captureWallMs, leanVersion: profile.leanVersion });
}
async function captured(file, name, thresholdMs) {
  const log = [];
  try {
    return await capture({ file, extensionRoot: root, thresholdMs, mode: 'detailed',
      output: path.join(results, `${name}.leanprofile.json`), onLog: text => log.push(text) });
  } finally { await fs.writeFile(path.join(results, `${name}.capture.log`), log.join('')); }
}

async function portable() {
  await runProcess('lake', ['build'], fixtures);
  const profile = await captured(path.join(fixtures, 'SourceProfileFixtures/Accuracy.lean'), 'accuracy-fixture', 0);
  verifyIntegrity(profile, 'portable fixture');
  const oracle = JSON.parse(await fs.readFile(path.join(fixtures, 'expected-ranges.json'), 'utf8'));
  for (const expected of oracle.tactics) check(`range: ${expected.id}`, () => {
    const matches = exactNodes(profile, expected.range);
    assert(matches.length, `${expected.id}: no exact Source.tactic has the expected range`);
    assert.equal(sliceRange(profile.sourceText, matches[0].source), expected.text);
    assert.equal(Buffer.byteLength(profile.sourceText.slice(0, offset(profile.sourceText, expected.range.start))), expected.utf8Offset);
  });
  check('duplicate tactic text remains distinct', () => {
    const first = outerNode(profile, oracle.tactics.find(x => x.id === 'duplicate-first').range);
    const second = outerNode(profile, oracle.tactics.find(x => x.id === 'duplicate-second').range);
    assert.notEqual(first.id, second.id); assert(!sameRange(first.source, second.source));
  });
  check('nested tactic range and elapsed work nest in actual call tree', () => {
    const parent = outerNode(profile, oracle.tactics.find(x => x.id === 'nested-parent').range);
    const childRange = oracle.tactics.find(x => x.id === 'nested-child').range;
    assert(descendants(profile, parent.id).some(n => n.sourceKind === 'exact' && sameRange(n.source, childRange)));
  });
  check('recursive reduction contains isDefEq and whnf with caller attribution', () => {
    const site = outerNode(profile, oracle.tactics.find(x => x.id === 'recursive-reduction').range);
    const internal = descendants(profile, site.id);
    assert(internal.some(n => n.category.startsWith('Meta.isDefEq')));
    assert(internal.some(n => n.category.startsWith('Meta.whnf')));
    assert(internal.some(n => n.detail.includes('transparentIteration')));
  });
  for (const declaration of oracle.declarations) check(`imported definition navigation: ${declaration.name}`, () => {
    const symbols = profile.nodes.flatMap(n => n.symbols || []).filter(s => s.name === declaration.name);
    assert(symbols.length, 'semantic symbol reference recorded');
    const expectedFile = path.join(fixtures, declaration.file);
    assert(symbols.some(s => s.file === expectedFile && s.range &&
      comparePosition(s.range.start, declaration.selectionRange.start) <= 0 &&
      comparePosition(s.range.end, declaration.selectionRange.end) >= 0), 'declaration range includes its name in the imported file');
    assert(profile.sourceTexts[expectedFile], 'imported source snapshot retained for stale detection');
    if (declaration.name.endsWith('.importedAdd_zero')) {
      assert(symbols.every(s => s.kind === 'reference'), 'imported opaque proof reference must not be billed as unfolding');
    } else {
      assert(symbols.some(s => s.kind === 'unfold'), 'explicit delta-unfold marker recorded for the reducible definition');
      for (const n of profile.nodes) if ((n.symbols || []).some(s => s.name === declaration.name && s.kind === 'unfold')) {
        assert(n.category.startsWith('Meta.isDefEq'), 'delta unfolding marker attached to the actual equality-checking event');
      }
    }
  });
  check('saved source is byte-identical after capture', () => assert.equal(profile.sourceText, profile.sourceTexts[profile.sourceFile]));
  const reopened = await readProfile(profile.profilePath);
  check('saved recording round-trip preserves sources and normalized timing', () => {
    assert.equal(reopened.nodes.length, profile.nodes.length);
    assert.equal(reopened.sourceText, profile.sourceText);
    for (let i = 0; i < profile.nodes.length; i++) assert.equal(reopened.nodes[i].selfMs, profile.nodes[i].selfMs);
  });
}
function offset(source, position) {
  const lines = source.split('\n');
  return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
}

async function navierStokes(variant, fixture) {
  const project = path.join(benchmark, variant);
  const directory = await fs.mkdtemp(path.join(project, 'SourceProfilerAccuracy'));
  const file = path.join(directory, 'MeanField.lean');
  const source = await fs.readFile(path.join(fixtures, 'ns', fixture), 'utf8');
  try {
    await fs.writeFile(file, source, { flag: 'wx' });
    const compileStart = performance.now();
    await runProcess('lake', ['env', 'lean', '-j1', file], project);
    const uninstrumentedWallMs = performance.now() - compileStart;
    const profile = await captured(file, `ns-${variant}`, 1);
    verifyIntegrity(profile, variant);
    const ranges = {
      originalFunext: { start: { line: 11, character: 2 }, end: { line: 11, character: 10 } },
      originalExact: { start: { line: 12, character: 2 }, end: { line: 13, character: 45 } },
      explicitFunext: { start: { line: 18, character: 2 }, end: { line: 18, character: 10 } },
      explicitDsimp: { start: { line: 19, character: 2 }, end: { line: 19, character: 59 } },
      explicitExact: { start: { line: 20, character: 2 }, end: { line: 21, character: 45 } }
    };
    const selected = {};
    for (const [name, range] of Object.entries(ranges)) check(`${variant}: ${name} source range`, () => {
      selected[name] = outerNode(profile, range);
      assert.equal(selected[name].source.file, file);
    });
    if (selected.originalExact) check(`${variant}: original exact contains internal equality/reduction work`, () => {
      const internal = descendants(profile, selected.originalExact.id);
      assert(internal.some(n => n.category.startsWith('Meta.isDefEq')));
      // At 1 ms LeanPool's whnf children may all fall below the threshold.
      // Threshold-0 portable coverage above requires both categories.
      if (variant === 'oai') assert(internal.some(n => n.category.startsWith('Meta.whnf')));
    });
    check(`${variant}: profiling preserves fixture source`, () => assert.equal(profile.sourceText, source));
    report.ns[variant] = {
      uninstrumentedWallMs, captureWallMs: profile.captureWallMs, elaborationElapsedMs: profile.elapsedMs,
      timingsMs: Object.fromEntries(Object.entries(selected).map(([name, n]) => [name, n.durationMs])),
      originalExactOverExplicitExact: selected.originalExact && selected.explicitExact?.durationMs > 0
        ? selected.originalExact.durationMs / selected.explicitExact.durationMs : null,
      overheadWallRatio: profile.captureWallMs / uninstrumentedWallMs,
      note: 'One run, imports cached; capture includes driver compilation, trace collection, export and serialization. Ratios are observations, not pass/fail thresholds. Source fixture copy removed after test.'
    };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function negativeCases() {
  const directory = await fs.mkdtemp(path.join(fixtures, 'SourceProfilerErrors'));
  const malformed = path.join(directory, 'Malformed.lean');
  const missingImport = path.join(directory, 'MissingImport.lean');
  const heartbeatTrace = path.join(directory, 'HeartbeatTrace.lean');
  const kernelFailure = path.join(directory, 'KernelFailure.lean');
  const output = path.join(results, 'must-not-overwrite.json');
  try {
    await fs.writeFile(malformed, 'theorem broken : False := by\n  exact True.intro\n');
    await fs.writeFile(missingImport, 'import SourceProfilerFixtureModuleThatDoesNotExist\n\ntheorem otherwise_valid : True := by\n  exact True.intro\n');
    await fs.writeFile(heartbeatTrace, 'import Lean\n\nset_option trace.profiler.useHeartbeats true\n\ntheorem heartbeat_trace : True := by\n  exact True.intro\n');
    await fs.writeFile(kernelFailure, 'import Lean\nopen Lean Elab Command\nelab "#wrong_kernel" : command => liftCoreM do\n  addDecl (.thmDecl { name := `brokenKernel, levelParams := [], type := mkConst ``False, value := mkConst ``True.intro })\n#wrong_kernel\n');
    await fs.writeFile(output, 'previous-valid-recording-sentinel');
    await asyncCheck('elaboration failure preserves previous output', async () => {
      await assert.rejects(capture({ file: malformed, extensionRoot: root, output }), /failed|error/i);
      assert.equal(await fs.readFile(output, 'utf8'), 'previous-valid-recording-sentinel');
    });
    await asyncCheck('missing import rejects capture and preserves previous output', async () => {
      await assert.rejects(capture({ file: missingImport, extensionRoot: root, output }), /SourceProfilerFixtureModuleThatDoesNotExist/);
      assert.equal(await fs.readFile(output, 'utf8'), 'previous-valid-recording-sentinel');
    });
    await asyncCheck('kernel rejects an invalid declaration supplied directly by an elaborator', async () => {
      await assert.rejects(capture({file:kernelFailure,extensionRoot:root,output}),/\(kernel\) declaration type mismatch/);
      assert.equal(await fs.readFile(output,'utf8'),'previous-valid-recording-sentinel');
    });
    await asyncCheck('heartbeat trace mode rejects mixed timing units and preserves previous output', async () => {
      await assert.rejects(capture({ file: heartbeatTrace, extensionRoot: root, output }), /requires wall.clock traces|useHeartbeats/i);
      assert.equal(await fs.readFile(output, 'utf8'), 'previous-valid-recording-sentinel');
    });
    await asyncCheck('malformed recording is rejected', async () => {
      await assert.rejects(readProfile(output), /JSON|profile/i);
    });
    await asyncCheck('cancellation ends capture promptly without publishing output', async () => {
      const controller = new AbortController();
      const cancelledOutput = path.join(directory, 'cancelled.leanprofile.json');
      const start = performance.now();
      const timer = setTimeout(() => controller.abort(), 200);
      try {
        await assert.rejects(capture({ file: path.join(fixtures, 'SourceProfileFixtures/Accuracy.lean'),
          extensionRoot: root, output: cancelledOutput, signal: controller.signal }), /cancelled/i);
        assert(performance.now() - start < 6000, 'cancelled process exits within 6 seconds');
        await assert.rejects(fs.access(cancelledOutput));
      } finally { clearTimeout(timer); }
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); await fs.rm(output, { force: true }); }
}

(async () => {
  await fs.mkdir(results, { recursive: true });
  await asyncCheck('portable capture completed', portable);
  if (!process.argv.includes('--skip-ns')) {
    await asyncCheck('OAI NS capture completed', () => navierStokes('oai', 'OaiMeanField.lean'));
    await asyncCheck('LeanPool NS capture completed', () => navierStokes('leanpool', 'LeanPoolMeanField.lean'));
  }
  await asyncCheck('negative cases completed', negativeCases);
  report.completedAt = new Date().toISOString();
  report.passed = errors.length === 0;
  report.summary = { passed: report.checks.filter(x => x.passed).length, failed: report.checks.filter(x => !x.passed).length };
  const reportName = process.argv.includes('--skip-ns') ? 'accuracy-portable.json' : 'accuracy.json';
  await fs.writeFile(path.join(results, reportName), JSON.stringify(report, null, 2) + '\n');
  for (const entry of report.checks) console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.name}${entry.error ? '\n' + entry.error : ''}`);
  console.log(`Report: ${path.join(results, reportName)}`);
  process.exitCode = errors.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
