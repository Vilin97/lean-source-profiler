#!/usr/bin/env node
// The native shell and both profiling modes must honor the same module configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { capture, prepareBackend, runProcess } = require('../out/capture.js');
const extensionRoot = path.resolve(__dirname, '..');
(async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-config-contract-'));
  try {
    await fs.writeFile(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.34.0-rc2\n');
    await fs.writeFile(path.join(project, 'lakefile.toml'), 'name = "configured-fixture"\n');
    const file = path.join(project, 'Configured.lean');
    const setup = path.join(project, '.lake/build/ir/Configured.setup.json');
    await fs.mkdir(path.dirname(setup), { recursive: true });
    const options = { autoImplicit: false, 'Elab.async': false };
    await fs.writeFile(setup, JSON.stringify({ name: 'Configured', isModule: false,
      package: 'configured-fixture', options, plugins: [], dynlibs: [], importArts: {} }));
    const backend = await prepareBackend(project, 'lake', extensionRoot);
    const native = () => runProcess(backend.leanExecutable, ['--setup', setup, file], project,
      undefined, undefined, backend.env);
    await fs.writeFile(file, 'theorem explicitValue (n : Nat) : n + 0 = n := by rfl\n');
    await native();
    const output = path.join(project, 'capture.json');
    const p = await capture({ file, extensionRoot, output });
    assert.equal(p.moduleSetup.mode, 'lake');
    assert.deepEqual(p.moduleSetup.options, options);
    assert(!p.nodes.some(n => n.category === 'Elab.async'), 'explicit async=false is preserved');
    const previous = await fs.readFile(output);
    await fs.writeFile(file, 'theorem implicitValue : n + 0 = (n : Nat) := by rfl\n');
    await assert.rejects(native(), /Unknown identifier|unknown identifier/);
    for (const mode of ['compact', 'detailed']) {
      await assert.rejects(capture({ file, extensionRoot, output, mode }), /Unknown identifier|unknown identifier/);
      assert.deepEqual(await fs.readFile(output), previous);
    }
    await fs.writeFile(file, 'set_option trace.profiler.useHeartbeats true\n' +
      'theorem heartbeatClock : True := by trivial\n');
    await assert.rejects(capture({ file, extensionRoot, output }), /requires wall-clock traces/);
    assert.deepEqual(await fs.readFile(output), previous);
    await fs.writeFile(file, 'import Lean\nopen Lean Elab Command\n' +
      'elab "#wrong_kernel" : command => liftCoreM do\n' +
      '  addDecl (.thmDecl { name := `brokenKernel, levelParams := [], type := mkConst ``False, value := mkConst ``True.intro })\n' +
      '#wrong_kernel\n');
    await assert.rejects(native(), /\(kernel\) declaration type mismatch/);
    for (const mode of ['compact', 'detailed']) {
      await assert.rejects(capture({ file, extensionRoot, output, mode }), /\(kernel\) declaration type mismatch/);
      assert.deepEqual(await fs.readFile(output), previous);
    }
    console.log('PASS setup: native/configured option parity, explicit async=false, heartbeat-clock rejection, kernel rejection in both modes and atomic failure.');
  } finally { await fs.rm(project, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
