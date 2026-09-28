'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryRows, buildFileIndex, folderRows } = require('../out/query.js');

const rows = Object.freeze([
  { kind: 'folder', name: 'Foo', path: 'Foo', durationMs: 120 },
  { kind: 'file', name: 'A.lean', path: 'Foo/A.lean', durationMs: 80 },
  { kind: 'declaration', name: 'Demo.big', path: 'Foo/A.lean', durationMs: 50, selfMs: 20, line: 10, endLine: 18 },
  { kind: 'tactic', name: 'exact largeProof', path: 'Foo/A.lean', durationMs: 30, selfMs: 5, line: 14, endLine: 16, declaration: 'Demo.big', eventId: '17' },
  { kind: 'file', name: 'C.lean', path: 'Foobar/C.lean', durationMs: 100 },
  { kind: 'file', name: 'D.lean', path: 'foo/D.lean', durationMs: 10 },
  { kind: 'tactic', name: 'exact smallProof', path: 'Foo/B.lean', durationMs: 3, selfMs: 2, line: 7, endLine: 7, eventId: '3' },
  { kind: 'declaration', name: 'Demo.other', path: 'Foo/B.lean', durationMs: 70, line: 3, endLine: 7 },
  { kind: 'file', name: 'Root.lean', path: 'Root.lean', durationMs: 1 }
].map(Object.freeze));

test('query sorts descending duration without changing the index', () => {
  const before = JSON.stringify(rows);
  const answer = queryRows(rows, {});
  assert.deepEqual(answer.map(x => x.durationMs), [120, 100, 80, 70, 50, 30, 10, 3, 1]);
  assert.equal(JSON.stringify(rows), before);
  assert.notEqual(answer, rows);
});

test('kind filter precedes limit and keeps exact recorded values', () => {
  const answer = queryRows(rows, { kind: 'file', limit: 1 });
  assert.equal(answer.length, 1);
  assert.equal(answer[0].path, 'Foobar/C.lean');
  assert.equal(answer[0].durationMs, 100);
  assert.deepEqual(queryRows(rows, { kind: 'tactic', limit: 10 }).map(x => x.name), ['exact largeProof', 'exact smallProof']);
});

test('path filter selects a directory boundary, with case sensitivity', () => {
  const answer = queryRows(rows, { path: 'Foo', limit: 100 });
  assert.equal(answer.length, 6);
  assert(answer.every(x => x.path === 'Foo' || x.path.startsWith('Foo/')));
  assert(!answer.some(x => x.path.startsWith('Foobar/') || x.path.startsWith('foo/')));
  assert.deepEqual(queryRows(rows, { path: 'foo' }).map(x => x.path), ['foo/D.lean']);
});

test('a file path includes its declaration and tactic rows', () => {
  const answer = queryRows(rows, { path: 'Foo/A.lean' });
  assert.deepEqual(answer.map(x => x.kind), ['file', 'declaration', 'tactic']);
  assert.equal(answer.find(x => x.kind === 'tactic').line, 14);
  assert.equal(answer.find(x => x.kind === 'tactic').endLine, 16);
  assert.equal(answer.find(x => x.kind === 'tactic').eventId, '17');
});

test('empty and dot paths include every row; unknown path gives no rows', () => {
  assert.deepEqual(queryRows(rows, { path: '' }), queryRows(rows, {}));
  assert.deepEqual(queryRows(rows, { path: '.' }), queryRows(rows, {}));
  assert.deepEqual(queryRows(rows, { path: 'Missing' }), []);
});

test('self-time sorting excludes rows with no measured self time', () => {
  const answer = queryRows(rows, { sort: 'selfMs' });
  assert.deepEqual(answer.map(x => x.selfMs), [20, 5, 2]);
});

test('query supports each row kind and a bounded positive integral limit', () => {
  for (const kind of ['file', 'folder', 'declaration', 'tactic']) {
    assert(queryRows(rows, { kind }).every(x => x.kind === kind));
  }
  assert.equal(queryRows(rows, { limit: 100000 }).length, rows.length);
  assert.equal(queryRows(Array.from({ length: 25 }, (_, i) => ({ kind: 'file', name: `${i}`, path: `${i}.lean`, durationMs: i })), {}).length, 20);
});

test('invalid kinds, sort keys, and limits reject rather than silently changing scope', () => {
  for (const kind of ['all', 'proof', '', 1]) assert.throws(() => queryRows(rows, { kind }));
  for (const sort of ['startMs', '', 1]) assert.throws(() => queryRows(rows, { sort }));
  for (const limit of [0, -1, 1.5, Infinity, NaN, 100001, '3']) assert.throws(() => queryRows(rows, { limit }));
  assert.throws(() => queryRows([], { limit: 0 }));
});

test('query paths reject absolute paths and parent-directory traversal', () => {
  for (const filter of ['/tmp/file.lean', '..', '../Foo', 'Foo/../Foobar', 'Foo/../../etc']) {
    assert.throws(() => queryRows(rows, { path: filter }), filter);
  }
});

function syntheticProfile() {
  const sourceFile = '/tmp/QueryFixture.lean';
  const source = (line, character, endLine = line, endCharacter = 11) => ({ file: sourceFile,
    start: { line, character }, end: { line: endLine, character: endCharacter } });
  const a = source(0, 0, 1), b = source(3, 0, 4);
  const node = (id, startMs, durationMs, range, extra = {}) => ({ id, parentId: null,
    category: 'Source.tactic', label: 'Source.tactic: Lean.Parser.Tactic.exact', detail: 'exact rfl',
    startMs, durationMs, selfMs: durationMs, source: range, sourceKind: 'exact', ...extra });
  return { schemaVersion: 1, sourceFile,
    sourceText: 'theorem a : True := by\n  exact rfl\n\ntheorem b : True := by\n  exact rfl\n\n#check Nat\n',
    leanVersion: 'test', elapsedMs: 50, captureWallMs: 80,
    declarations: [
      { name: 'Demo.a', source: a }, { name: 'Demo.alias', source: a },
      { name: 'Demo.generated', source: a, generated: true },
      { name: 'Demo.b', source: b }, { name: 'Demo.unrecorded', source: source(6, 0, 6, 10) }
    ],
    nodes: [
      node('a-command', 0, 10, a, { category: 'Elab.command', selfMs: 4 }),
      node('a-exact', 2, 5, source(1, 2), { selfMs: 1 }),
      node('a-wrapper', 3, 2, source(1, 2), { selfMs: 0.5 }),
      node('a-retry', 11, 3, source(1, 2)),
      node('a-inherited', 4, 1, source(1, 2), { category: 'Meta.whnf', sourceKind: 'inherited' }),
      node('a-sequence', 1, 8, a, { label: 'Source.tactic: Lean.Parser.Tactic.tacticSeqIndented' }),
      node('b-command', 20, 4, b, { category: 'Source.term' }),
      node('b-exact', 21, 2, source(4, 2)),
      node('b-inherited', 21, 1, source(4, 2), { sourceKind: 'inherited' }),
      node('foreign', 0, 999, { ...a, file: '/tmp/Imported.lean' })
    ] };
}

test('index unions repeated tactic intervals while keeping representative event and self time explicit', () => {
  const index = buildFileIndex(syntheticProfile(), 'Demo/QueryFixture.lean');
  const tactics = index.filter(row => row.kind === 'tactic');
  assert.equal(tactics.length, 2, 'container wrappers and inherited events are not extra tactic rows');
  const a = tactics.find(row => row.line === 2);
  assert.equal(a.name, 'exact rfl');
  assert.equal(a.durationMs, 8, 'union [2,7] + [11,14], with nested wrapper counted once');
  assert.equal(a.selfMs, 1, 'self time belongs to the documented representative event');
  assert.equal(a.eventId, 'a-exact');
  assert.equal(a.endLine, 2);
  assert.equal(a.declaration, 'Demo.a, Demo.alias');
  assert.equal(tactics.find(row => row.line === 5).durationMs, 2);
});

test('declaration totals union all owned intervals and label shared command ranges', () => {
  const index = buildFileIndex(syntheticProfile(), 'Demo/QueryFixture.lean');
  const declarations = index.filter(row => row.kind === 'declaration');
  assert.equal(declarations.length, 3, 'generated and completely unrecorded declarations do not invent timing rows');
  const a = declarations.find(row => row.name === 'Demo.a');
  assert.equal(a.durationMs, 13, 'union [0,10] + [11,14], not sum of nested work');
  assert.equal(a.attribution, 'shared');
  assert.deepEqual(a.sharedWith, ['Demo.a', 'Demo.alias']);
  assert.equal(declarations.find(row => row.name === 'Demo.alias').durationMs, 13);
  assert.equal(declarations.find(row => row.name === 'Demo.b').durationMs, 4);
  assert.equal(declarations.find(row => row.name === 'Demo.b').attribution, 'recorded-interval-union');
});

test('folder totals use each file once, without summing nested declaration or tactic rows', () => {
  const index = buildFileIndex(syntheticProfile(), 'Demo/nested/QueryFixture.lean');
  const folders = folderRows([...index, { kind: 'file', path: 'Demo/Other.lean', name: 'Other.lean', durationMs: 7 }]);
  assert.equal(folders.find(row => row.path === 'Demo/nested').durationMs, 50);
  assert.equal(folders.find(row => row.path === 'Demo').durationMs, 57);
  assert.equal(folders.find(row => row.path === '.').durationMs, 57);
  assert.equal(folders.length, 3);
});

test('nested declarations retain outer inclusive work after an inner declaration ends', () => {
  const sourceFile = '/tmp/NestedDeclarations.lean';
  const range = (startLine, endLine = startLine, startCharacter = 0, endCharacter = 0) => ({ file: sourceFile,
    start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } });
  const lines = Array.from({ length: 111 }, () => '-- filler');
  for (const line of [15, 16, 50, 106]) lines[line] = '  exact rfl';
  const node = (id, line, startMs, durationMs) => ({ id, parentId: null, category: 'Source.tactic',
    label: 'Source.tactic: Lean.Parser.Tactic.exact', detail: 'exact rfl', startMs, durationMs, selfMs: durationMs,
    sourceKind: 'exact', source: range(line, line, 2, 11) });
  const profile = { schemaVersion: 1, sourceFile, sourceText: lines.join('\n'), leanVersion: 'test', elapsedMs: 100,
    declarations: [
      { name: 'Outer', source: range(0, 100) }, { name: 'Inner', source: range(10, 20) },
      { name: 'Tail', source: range(105, 110) }
    ],
    nodes: [node('inside-inner', 15, 0, 20), node('nested-work', 16, 3, 5),
      node('after-inner', 50, 30, 40), node('following-top-level', 106, 80, 7)] };
  const index = buildFileIndex(profile, 'NestedDeclarations.lean');
  const declarations = index.filter(row => row.kind === 'declaration');
  assert.equal(declarations.find(row => row.name === 'Outer').durationMs, 60, 'outer includes inner20 + later40, nested5 counted once');
  assert.equal(declarations.find(row => row.name === 'Inner').durationMs, 20);
  assert.equal(declarations.find(row => row.name === 'Tail').durationMs, 7, 'following declaration does not leak into Outer');
  const tactics = index.filter(row => row.kind === 'tactic');
  assert.equal(tactics.find(row => row.eventId === 'inside-inner').declaration, 'Inner');
  assert.equal(tactics.find(row => row.eventId === 'after-inner').declaration, 'Outer');
  assert.equal(tactics.find(row => row.eventId === 'following-top-level').declaration, 'Tail');
});
