const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProfile, intervalUnion } = require('../out/model.js');

const node = (id, parentId, startMs, durationMs, extra = {}) => ({ id, parentId, startMs, durationMs, category: 'Meta.isDefEq', label: id, detail: '', ...extra });
const profile = nodes => ({ schemaVersion: 1, sourceFile: '/tmp/Example.lean', sourceText: 'example : True := by\n  trivial\n', leanVersion: '4.34.0-rc2', elapsedMs: 100, nodes });

test('exclusive times use clipped union of overlapping children', () => {
  const p = normalizeProfile(profile([node('root', null, 10, 100), node('a', 'root', 20, 40), node('b', 'root', 40, 50), node('c', 'root', 100, 50)]));
  assert.equal(p.nodes[0].selfMs, 20); // [20,90] + [100,110] = 80
  assert.equal(p.nodes[1].selfMs, 40);
});
test('recursion is not charged repeatedly to ancestor self time', () => {
  const p = normalizeProfile(profile([node('a', null, 0, 100), node('b', 'a', 1, 98), node('c', 'b', 2, 96)]));
  assert.deepEqual(p.nodes.map(n => n.selfMs), [2, 2, 96]);
});
test('duration union handles nesting and disjoint intervals', () => assert.equal(intervalUnion([[0,10],[1,2],[3,7],[20,30]]),20));
test('nullable Lean optional fields are accepted', () => {
  const p = normalizeProfile(profile([node('a',null,0,1,{source:null,sourceKind:null,symbols:null})]));
  assert.equal(p.nodes[0].source,undefined);
});
test('deep call trees validate without recursion overflow', () => {
  const nodes = Array.from({ length: 20000 }, (_,i) => node(String(i),i ? String(i-1):null,0,1));
  assert.equal(normalizeProfile(profile(nodes)).nodes.length,20000);
});
test('malformed recordings fail closed', () => {
  for (const nodes of [[node('a','missing',0,1)],[node('a','b',0,1),node('b','a',0,1)],[node('a',null,0,1),node('a',null,0,1)],[node('a',null,0,NaN)],[node('a',null,-1,2)]]) assert.throws(() => normalizeProfile(profile(nodes)),/Invalid/);
});
test('out of range source locations do not become misleading bars', () => {
  assert.throws(() => normalizeProfile(profile([node('a',null,0,1,{source:{file:'/tmp/Example.lean',start:{line:100,character:0},end:{line:100,character:1}},sourceKind:'exact'})])),/outside/);
});
test('range characters are UTF16 positions, including surrogate pairs', () => {
  const p = profile([node('a',null,0,1,{source:{file:'/tmp/Example.lean',start:{line:0,character:2},end:{line:0,character:3}},sourceKind:'exact'})]);
  p.sourceText='🦉x';
  assert.equal(normalizeProfile(p).nodes[0].source.start.character,2);
});
test('stock Firefox profile gives a specific recapture instruction', () => assert.throws(() => normalizeProfile({meta:{},threads:[]}),/Firefox.*source attribution/));
test('profile paths cannot be commands, URLs, or relative locations', () => {
  for (const file of ['command:workbench.action.terminal.new','https://example.com/Lean.lean','../x.lean']) assert.throws(() => normalizeProfile({...profile([]),sourceFile:file}),/absolute local/);
});
