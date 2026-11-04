#!/usr/bin/env node
// A warm profiler checkpoint must not conceal a deleted transitive dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildProject } = require('../scripts/capture-whole-pool.cjs');
(async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-build-recovery-'));
  try {
    await fs.writeFile(path.join(repository, 'lean-toolchain'), 'leanprover/lean4:v4.34.0-rc2\n');
    await fs.writeFile(path.join(repository, 'lakefile.toml'),
      'name = "build-recovery-fixture"\n[[lean_lib]]\nname = "LeanPool"\n');
    await fs.mkdir(path.join(repository, 'LeanPool'));
    await fs.writeFile(path.join(repository, 'LeanPool/Dependency.lean'), 'def dependencyValue : Nat := 7\n');
    await fs.writeFile(path.join(repository, 'LeanPool/Example.lean'),
      'import LeanPool.Dependency\nexample : dependencyValue = 7 := rfl\n');
    const project = { name: 'Example', files: [{ path: 'LeanPool/Example.lean' }] };
    const output = path.join(repository, 'recording');
    const dependency = path.join(repository, '.lake/build/lib/lean/LeanPool/Dependency.olean');
    const root = path.join(repository, '.lake/build/lib/lean/LeanPool/Example.olean');
    await buildProject(repository, output, project, 'lake');
    const rootBytes = await fs.readFile(root);
    await fs.unlink(dependency);
    await buildProject(repository, output, project, 'lake');
    assert((await fs.stat(dependency)).isFile(), 'Lake repairs imports behind a warm profiler checkpoint');
    assert.deepEqual(await fs.readFile(root), rootBytes, 'the source module remains unchanged');
    console.log('PASS build recovery: a retained root artifact and setup cannot hide a missing dependency.');
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
