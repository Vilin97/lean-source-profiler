#!/usr/bin/env node
'use strict';

// Focused backend contract test: no host normalizer can accidentally supply metadata.
// Run: node test/declarations.capture.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const driver = path.join(root, 'lean', 'SourceProfiler.lean');
const fixtureRoot = path.join(__dirname, 'fixtures');
const expected = new Map([
  ['twoTactics', [6, 8]], ['repeatedTactics', [11, 14]],
  ['multilineTactic', [17, 21]], ['unicodeColumns', [25, 26]],
  ['nestedTactics', [29, 32]], ['importedReduction', [35, 36]],
  ['reductionWork', [40, 41]], ['importedProof', [44, 45]],
]);
const compare = (a, b) => a.line - b.line || a.character - b.character;
const contained = (outer, inner) => inner && outer.file === inner.file &&
  compare(outer.start, inner.start) <= 0 && compare(inner.end, outer.end) <= 0;

function activeTime(nodes) {
  const points = nodes.flatMap(n => [[n.startMs, 1], [n.startMs + n.durationMs, -1]])
    .sort((a, b) => a[0] - b[0]);
  let depth = 0, total = 0, last = 0;
  for (const [time, delta] of points) {
    if (depth > 0) total += time - last;
    depth += delta; last = time;
  }
  return total;
}

async function capture(file, cwd, output) {
  const result = spawnSync('lake', ['env', 'lean', '--run', driver, file, output, '50'],
    { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  return JSON.parse(await fs.readFile(output, 'utf8'));
}

(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-declaration-contract-'));
  try {
    const profile = await capture('SourceProfileFixtures/Accuracy.lean', fixtureRoot,
      path.join(tmp, 'accuracy.json'));
    assert.equal(profile.declarations.length, expected.size);
    for (const declaration of profile.declarations) {
      const shortName = declaration.name.replace(/^SourceProfileFixtures\./, '');
      assert(expected.has(shortName), `unexpected/imported declaration ${declaration.name}`);
      const [first, last] = expected.get(shortName);
      assert.equal(declaration.source.file, profile.sourceFile);
      assert.deepEqual([declaration.source.start.line, declaration.source.end.line], [first, last]);
      assert.equal(declaration.kind, 'theorem');
      assert.equal(declaration.generated, false);
      assert.equal(declaration.durationMs, undefined, 'backend must not substitute dispatch time');
      const nodes = profile.nodes.filter(n => contained(declaration.source, n.source));
      const values = nodes.filter(n => n.category === 'Elab.definition.value');
      const workers = nodes.filter(n => n.category === 'Elab.async');
      assert(values.length > 0, `missing sub-threshold body scope for ${shortName}`);
      assert(workers.length > 0, `missing asynchronous worker for ${shortName}`);
      assert(workers.some(n => n.thread !== '0'), `worker assigned to frontend for ${shortName}`);
      const union = activeTime(nodes);
      assert(union > 0);
      for (const node of values.concat(workers)) assert(union + 0.001 >= node.durationMs);
    }

    // Cover a user-authored private name and generated recursors independently of NS.
    await fs.writeFile(path.join(tmp, 'lean-toolchain'), 'leanprover/lean4:v4.34.0-rc2\n');
    await fs.writeFile(path.join(tmp, 'lakefile.toml'), 'name = "declarationContract"\n');
    await fs.writeFile(path.join(tmp, 'Declarations.lean'), [
      'private def hidden : Nat := 1',
      'def shown : Nat := hidden',
      'inductive Switch where | on | off',
      'structure Box where value : Nat',
      '',
    ].join('\n'));
    const kinds = await capture('Declarations.lean', tmp, path.join(tmp, 'kinds.json'));
    const hidden = kinds.declarations.find(d => d.name.endsWith('.hidden'));
    assert(hidden && hidden.name.startsWith('_private.'), 'real private kernel name retained');
    assert.equal(hidden.generated, false, 'user-written private declaration is not generated');
    assert(kinds.declarations.some(d => d.name === 'shown' && d.kind === 'definition'));
    assert(kinds.declarations.some(d => d.name === 'Switch' && d.kind === 'inductive'));
    for (const d of kinds.declarations.filter(d => d.kind === 'recursor')) assert(d.generated);
    console.log('PASS semantic declarations: 8 exact theorem ranges, private names, kinds, async interval coverage at threshold 50 ms.');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
