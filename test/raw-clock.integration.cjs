#!/usr/bin/env node
// An imported tactic runs an independent Python raw stopwatch inside its source scope.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { capture, runProcess } = require('../out/capture.js');
const extensionRoot = path.resolve(__dirname, '..'), project = path.join(__dirname, 'fixtures');
(async () => {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    console.log('SKIP Linux raw clock oracle on this host'); return;
  }
  const temporary = await fs.mkdtemp(path.join(project, 'SourceProfileFixtures', 'ClockOracle'));
  const relative = path.relative(project, temporary);
  const moduleName = relative.split(path.sep).join('.') + '.Oracle';
  try {
    await fs.writeFile(path.join(temporary, 'Oracle.lean'), 'import Lean\nopen Lean Elab Tactic\n' +
      'elab (name := rawOracleTactic) "raw_clock_oracle" : tactic => do\n' +
      '  let measured ← IO.Process.output { cmd := "python3", args := #["-c", ' +
      '"import time; a=time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW); time.sleep(0.3); b=time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW); print(a,b)"] }\n' +
      '  IO.println s!"RAW_ORACLE {measured.stdout.trimAscii.toString}"\n' +
      '  evalTactic (← `(tactic| exact True.intro))\n');
    await runProcess('lake', ['build', moduleName], project);
    const file = path.join(temporary, 'Consumer.lean');
    await fs.writeFile(file, `import ${moduleName}\n\ntheorem clockOracle : True := by raw_clock_oracle\n`);
    let log = '';
    const profile = await capture({ file, extensionRoot, output: path.join(temporary, 'capture.json'),
      onLog: text => { log += text; } });
    const samples = /RAW_ORACLE (\d+) (\d+)/.exec(log);
    assert(samples, log);
    const start = (Number(samples[1]) / 1e9 - profile.clockCalibration.rawStartTime) * 1000;
    const elapsed = Number(BigInt(samples[2]) - BigInt(samples[1])) / 1e6;
    const node = profile.nodes.find(n => n.category === 'Source.tactic' && n.label.includes('rawOracleTactic'));
    assert(node, 'imported oracle tactic is instrumented');
    assert(start >= node.startMs - .001 && start + elapsed <= node.startMs + node.durationMs + .001);
    assert(node.durationMs - elapsed < 100, 'Python startup/exit and scope overhead around the independent sample are bounded');
    assert.equal(profile.sourceClock, 'CLOCK_MONOTONIC_RAW');
    console.log(`PASS raw clock: independently sampled ${elapsed.toFixed(3)}ms inside ${node.durationMs.toFixed(3)}ms source scope.`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    for (const subtree of ['lib/lean', 'ir']) {
      await fs.rm(path.join(project, '.lake', 'build', subtree, relative), { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
