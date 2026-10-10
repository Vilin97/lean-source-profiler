const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProfile } = require('../out/model.js');
const { summarize } = require('../scripts/whole-pool-summary.cjs');

const source = '/recording/LeanPool/Basic.lean';
const range = (start, end = start) => ({ file: source, start: { line: start, character: 0 }, end: { line: end, character: 1 } });
const event = (id, parent, start, duration, line, thread = '1') => ({ id, parentId: parent, category: 'Source.tactic', label: 'exact', startMs: start, durationMs: duration, thread, source: range(line), sourceKind: 'exact' });
function profile(nodes, declarations = []) {
  return normalizeProfile({ schemaVersion: 1, sourceFile: source, sourceText: 'a\nb\nc\nd\ne\n', leanVersion: '4.35.0-rc3', elapsedMs: 12, nodes, declarations });
}
const entry = { id: '0', path: 'LeanPool/Basic.lean' };
const anchors = summary => summary.children.flatMap(group => group.children);

test('nested scopes allocate each interval once and retain the frontend remainder', () => {
  const summary = summarize(profile([event('0', null, 1, 10, 0), event('1', '0', 3, 4, 1)]), entry);
  assert.equal(summary.sourceValue, 10);
  assert.deepEqual(anchors(summary).map(line => [line.line, line.value]), [[1, 6], [2, 4]]);
  assert.equal(summary.children.at(-1).value, 2);
  assert.equal(summary.children.reduce((sum, group) => sum + group.value, 0), 12);
});

test('concurrent threads share overlap and out-of-frontend scopes are clipped', () => {
  const summary = summarize(profile([event('0', null, 0, 8, 0), event('1', null, 4, 20, 1, '2')]), entry);
  assert.equal(summary.sourceValue, 12);
  assert.deepEqual(anchors(summary).map(line => [line.line, line.value]), [[1, 6], [2, 6]]);
});

test('semantic declarations retain untimed entries and the smallest containing owner', () => {
  const declarations = [{ name: 'outer', source: range(0, 4) }, { name: 'inner', source: range(0, 2) }, { name: 'untimed', source: range(3, 4) }];
  const summary = summarize(profile([event('0', null, 1, 6, 1)], declarations), entry);
  assert.equal(summary.children.find(group => group.name === 'inner').sourceValue, 6);
  assert.equal(summary.children.find(group => group.name === 'outer').sourceValue, 0);
  assert.equal(summary.children.find(group => group.name === 'untimed').attributionStatus, 'no-separate-timing');
  assert.equal(summary.children.find(group => group.name === 'inner').range.file, entry.path);
});

test('shared declaration ranges do not duplicate allocated time', () => {
  const summary = summarize(profile([event('0', null, 1, 6, 1)], [{ name: 'first', source: range(0, 2) }, { name: 'second', source: range(0, 2) }]), entry);
  assert.equal(summary.children[0].name, 'first, second');
  assert.equal(summary.children[0].value, 6);
  assert.equal(summary.children[0].inclusiveMs, 6);
});
