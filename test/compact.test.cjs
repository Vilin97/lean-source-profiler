const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProfile } = require('../out/model.js');
const fixture = () => ({ schemaVersion: 3, kind: 'lean-source-profile-compact',
  sourceFile: '/tmp/Compact.lean', sourceText: '🦉x\n', leanVersion: '4.34.0', elapsedMs: 10,
  classes: [['Source.tactic', 'Source.tactic: exact']], ranges: [[0, 2, 0, 3]],
  events: [[-1, 0, 1, 8, '1', 0, 1], [0, 0, 2, 3, '1', 0, 2]] });
test('compact tables retain threads, source ranges, parenting and exclusive time', () => {
  const profile = normalizeProfile(fixture());
  assert.equal(profile.captureMode, 'compact');
  assert.deepEqual(profile.nodes.map(n => [n.id, n.parentId, n.selfMs, n.thread]), [['0', null, 5, '1'], ['1', '0', 3, '1']]);
  assert.equal(profile.nodes[0].source.start.character, 2);
  assert.equal(profile.nodes[1].sourceKind, 'inherited');
  assert.equal(profile.nodes[0].detail, '');
});
test('compact corrupt references and nonfinite clocks fail closed', () => {
  for (const change of [[0, 0], [1, 99], [2, NaN], [3, -1], [4, 1], [5, 99], [6, 0]]) {
    const data = fixture(); data.events[0][change[0]] = change[1];
    assert.throws(() => normalizeProfile(data), /Invalid/);
  }
  for (const range of [[0, 3, 0, 2], [99, 0, 99, 1], [0, -1, 0, 3]]) {
    const data = fixture(); data.ranges[0] = range;
    assert.throws(() => normalizeProfile(data), /Invalid/);
  }
});
test('empty or unordered clock calibration cannot produce a capture duration', () => {
  for (const clockCalibration of [
    { startTime: 1, importTime: 1, stopTime: 1, importElapsed: 0, elapsed: 0 },
    { startTime: 2, importTime: 1, stopTime: 3, importElapsed: 1, elapsed: 2 },
    { startTime: 1, importTime: 2, stopTime: 3, importElapsed: 2, elapsed: 1 },
  ]) assert.throws(() => normalizeProfile({ ...fixture(), clockCalibration }), /clock calibration/);
});
