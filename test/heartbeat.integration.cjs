#!/usr/bin/env node
// Compact source timers must leave Lean's internal tracing fast path and proof budgets intact.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { capture, prepareBackend, runProcess } = require('../out/capture.js');
const extensionRoot = path.resolve(__dirname, '..');
(async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-heartbeat-contract-'));
  try {
    await fs.writeFile(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.34.0-rc2\n');
    await fs.writeFile(path.join(project, 'lakefile.toml'), 'name = "heartbeat-fixture"\n');
    const file = path.join(project, 'Heartbeat.lean'), output = path.join(project, 'capture.json');
    const source = `import Lean
open Lean Elab Tactic
class Chain (n : Nat) : Prop where
  holds : True
instance : Chain 0 := ⟨trivial⟩
instance [Chain n] : Chain (n + 1) := ⟨trivial⟩
elab "check_native_budget" : tactic => do
  let opts ← getOptions
  if opts.hasTrace then throwError "Internal tracing would charge the proof budget."
  unless opts.get "synthInstance.maxHeartbeats".toName (0 : Nat) == 100 do
    throwError "The native typeclass budget changed."
set_option synthInstance.maxHeartbeats 100
example : Chain 80 := by
  check_native_budget
  infer_instance
`;
    await fs.writeFile(file, source);
    const backend = await prepareBackend(project, 'lake', extensionRoot);
    const native = () => runProcess(backend.leanExecutable, [file], project,
      undefined, undefined, backend.env);
    await native();
    const profile = await capture({ file, extensionRoot, output });
    assert(profile.nodes.some(n => n.category === 'Source.tactic'), 'source timers remain active');
    const previous = await fs.readFile(output);
    await fs.writeFile(file, source.replace('maxHeartbeats 100', 'maxHeartbeats 1')
      .replace('  check_native_budget\n', ''));
    await assert.rejects(native(), /maximum number of heartbeats/);
    await assert.rejects(capture({ file, extensionRoot, output }), /maximum number of heartbeats/);
    assert.deepEqual(await fs.readFile(output), previous, 'failed capture cannot replace a valid one');
    console.log('PASS heartbeat: compact source timers preserve native internal-tracing fast path and typeclass limits.');
  } finally { await fs.rm(project, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
