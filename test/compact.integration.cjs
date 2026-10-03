#!/usr/bin/env node
// Two independent exporters consume ONE execution: timing differences cannot hide lost data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareBackend, runProcess, readProfile, capture } = require('../out/capture.js');
const { buildFileIndex } = require('../out/query.js');
const root = path.resolve(__dirname, '..'), project = path.join(__dirname, 'fixtures');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-contract-'));
  try {
    const backend = await prepareBackend(project, 'lake', root);
    const file = path.join(project, 'SourceProfileFixtures', 'Accuracy.lean');
    const output = path.join(temp, 'detailed.json');
    await runProcess(backend.executable, [file, output, '50', 'verify'], project, undefined, undefined, backend.env);
    const detailed = await readProfile(output), compact = await readProfile(output + '.compact.json');
    const timing = p => p.nodes.map(({ id, parentId, category, label, startMs, durationMs, selfMs, thread, source, sourceKind }) =>
      ({ id, parentId, category, label, startMs, durationMs, selfMs, thread, source, sourceKind }));
    assert.deepEqual(timing(compact), timing(detailed));
    assert.deepEqual(compact.declarations, detailed.declarations);
    assert.equal(compact.declarations.length, 8);
    assert.equal(compact.elapsedMs, detailed.elapsedMs);
    for(const n of compact.nodes) assert(n.startMs>=0&&n.startMs+n.durationMs<=compact.elapsedMs+0.01,'all source and builtin timers share the frontend clock');
    if(process.platform==='linux') {
      assert.equal(compact.clock,'Linux CLOCK_MONOTONIC_RAW (Lean builtin trace calibration)');
      assert.equal(compact.sourceClock,'CLOCK_MONOTONIC_RAW');
      assert(compact.clockCalibration.rawStartTime>0);
    }
    assert.deepEqual(buildFileIndex(compact, 'Accuracy.lean'), buildFileIndex(detailed, 'Accuracy.lean'));
    const oracle=JSON.parse(await fs.readFile(path.join(project,'expected-ranges.json'),'utf8'));
    for(const tactic of oracle.tactics) {
      assert(compact.nodes.some(n=>n.category==='Source.tactic'&&n.sourceKind==='exact'&&
        JSON.stringify({start:n.source.start,end:n.source.end})===JSON.stringify(tactic.range)),tactic.id);
    }
    const compare=(a,b)=>a.line-b.line||a.character-b.character;
    for (const d of compact.declarations) {
      const rows = buildFileIndex(compact, 'Accuracy.lean').filter(r => r.kind === 'declaration' && r.name === d.name);
      assert.equal(rows.length, 1); assert(rows[0].durationMs > 0);
      const nodes=compact.nodes.filter(n=>n.source&&compare(d.source.start,n.source.start)<=0&&compare(n.source.end,d.source.end)<=0);
      assert(nodes.some(n=>n.category==='Elab.async'&&n.thread!=='0'),`asynchronous proof/kernel coverage: ${d.name}`);
      assert(nodes.some(n=>n.category==='Elab.definition.value'),`sub-threshold declaration body: ${d.name}`);
    }
    const saved = path.join(temp, 'capture.json');
    const fresh = await capture({ file, extensionRoot: root, output: saved });
    const raw = JSON.parse(await fs.readFile(saved, 'utf8'));
    assert.equal(raw.schemaVersion, 3); assert.equal(raw.nodes, undefined);
    assert.deepEqual((await readProfile(saved)).nodes, fresh.nodes);
    assert.equal(raw.captureWallMs,fresh.captureWallMs,'write-inclusive duration is saved without rewriting the trace');
    if(process.platform==='linux')assert(raw.clockCalibration&&raw.clockCalibration.elapsed>0);
    assert.equal(fresh.sourceText, await fs.readFile(file, 'utf8'));
    assert(raw.driverSha256 && raw.clockSha256 && raw.compilerGitHash);
    console.log('PASS compact: exact same-run event/range/thread/declaration/self-time/query parity; default capture round-trip.');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
