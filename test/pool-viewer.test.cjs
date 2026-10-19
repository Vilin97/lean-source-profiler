const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function viewer(data) {
  const elements = new Map();
  const context = vm.createContext({
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    ResizeObserver: class { observe() {} },
    data,
  });
  const script = fs.readFileSync(path.join(__dirname, '../docs/pool/app.js'), 'utf8').replace(/\nrefresh\(\);\s*$/, '\n');
  vm.runInContext(script, context);
  vm.runInContext('overview=data;root=buildTree(data);current=root;', context);
  return context;
}

const data = {
  name: 'LeanPool', inventory: [{ name: 'Example', files: 3, lines: 999 }, { name: 'Basic', files: 1, lines: 999 }],
  files: {
    'LeanPool/Example/Sub/A.lean': { id: '1', lines: 10, value: 20, sourceValue: 12 },
    'LeanPool/Example/Sub/B.lean': { id: '2', lines: 4, value: 8, sourceValue: 2 },
    'LeanPool/Example/Empty.lean': { id: '3', lines: 0, value: 1, sourceValue: 0 },
    'LeanPool/Basic.lean': { id: '4', lines: 2, value: 3, sourceValue: 1 },
  },
};

test('pool LOC aggregates each file once through folders, projects and root modules', () => {
  const context = viewer(data);
  const root = vm.runInContext('root', context);
  assert.equal(root.lines, 16);
  assert.equal(root.sourceValue, 15);
  const project = root.children.find(node => node.name === 'Example');
  assert.equal(project.lines, 14);
  assert.equal(project.completed, 3);
  assert.equal(project.children.find(node => node.kind === 'folder').lines, 14);
  assert.equal(root.children.find(node => node.name === 'Basic').lines, 2);
  vm.runInContext('metric="lines";', context);
  assert.equal(vm.runInContext('formatValue(weight(root))', context), '16 LOC');
  assert.equal(vm.runInContext('formatValue(0)', context), '0 LOC');
});

test('LOC stops at files even after timing declarations have loaded', () => {
  const context = viewer(data);
  vm.runInContext('file=findFile("LeanPool/Example/Sub/A.lean");file.loaded=true;file.children=[{kind:"declaration",name:"a",sourceValue:12,parent:file,file,children:[]}];metric="lines";', context);
  assert.equal(vm.runInContext('childrenOf(file).length', context), 0);
  vm.runInContext('metric="sourceValue";', context);
  assert.equal(vm.runInContext('childrenOf(file).length', context), 1);
  assert.equal(vm.runInContext('formatValue(weight(root))', context), '15.00 ms');
  assert.equal(vm.runInContext('sourceFile(file.children[0])===file', context), true);
});

test('pool dropdown offers LOC in place of frontend time', () => {
  const html = fs.readFileSync(path.join(__dirname, '../docs/pool/index.html'), 'utf8');
  assert.match(html, /<option value="lines">LOC<\/option>/);
  assert.doesNotMatch(html, /<option value="value">/);
});

test('public pool export derives physical LOC from audited source, preserving asset hashes', async t => {
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { gunzipSync } = require('node:zlib');
  const { createHash } = require('node:crypto');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pool-loc-export-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const recording = path.join(directory, 'recording'), destination = path.join(directory, 'public');
  await fsp.mkdir(path.join(recording, 'full/summaries'), { recursive: true });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const sources = ['', 'theorem a : True := by trivial\n', '-- comment\r\n\r\n', 'last line'];
  const entries = sources.map((source, id) => ({ id: String(id), path: `LeanPool/Example/F${id}.lean`, status: 'ok', sha256: hash(source) }));
  const writeJson = (relative, value) => fsp.writeFile(path.join(recording, relative), JSON.stringify(value));
  const session = { status: 'complete', files: entries, startedAt: '2026-10-19T00:00:00Z', completedAt: '2026-10-19T01:00:00Z', wallMs: 3600000 };
  const files = Object.fromEntries(entries.map(entry => [entry.path, { id: entry.id, path: entry.path, value: 1, sourceValue: 1 }]));
  await writeJson('inventory.json', { repository: directory, commit: 'source-fixture', profilerCommit: 'profiler-fixture', files: entries.length, projects: [{ name: 'Example', files: entries }] });
  await writeJson('full/overview.json', { name: 'LeanPool', session, files });
  await writeJson('final-coverage.json', { result: 'PASS' });
  for (const entry of entries) await writeJson(`full/summaries/${entry.id}.json`, { ...files[entry.path], source: sources[Number(entry.id)], children: [] });
  await fsp.writeFile(path.join(directory, 'LICENSE'), 'Fixture license\n');
  await fsp.writeFile(path.join(directory, 'NOTICE'), 'Fixture notice\n');
  await fsp.mkdir(path.join(directory, 'LeanPool/projects'), { recursive: true });
  execFileSync('python3', ['scripts/export-whole-pool.py', recording, destination], { cwd: path.join(__dirname, '..') });
  const manifest = JSON.parse(await fsp.readFile(path.join(destination, 'manifest.json'), 'utf8'));
  const compressed = await fsp.readFile(path.join(destination, 'data/overview.json.gz'));
  assert.equal(hash(compressed), manifest.overview.sha256);
  assert.equal(compressed.length, manifest.overview.bytes);
  const overview = JSON.parse(gunzipSync(compressed));
  assert.deepEqual(Object.values(overview.files).map(file => file.lines), [0, 1, 2, 1]);
  assert.deepEqual(manifest.files.map(file => file.lines), [0, 1, 2, 1]);
  for (const entry of manifest.files) {
    const asset = await fsp.readFile(path.join(destination, entry.asset));
    assert.equal(hash(asset), entry.sha256);
    assert.equal(JSON.parse(gunzipSync(asset)).source, sources[Number(entry.id)]);
  }
});

test('switching a declaration to LOC and reloading a line link selects its file', async () => {
  const context = viewer(data);
  vm.runInContext('file=findFile("LeanPool/Example/Sub/A.lean");file.loaded=true;file.source="source\\n";file.children=[{kind:"declaration",name:"a",sourceValue:12,parent:file,file,children:[]}];current=file.children[0];render=()=>{};$("metric").value="lines";$("metric").onchange();', context);
  assert.equal(vm.runInContext('current===file', context), true);
  context.location = { search: '?path=LeanPool/Example/Sub/A.lean&line=1' };
  context.URLSearchParams = URLSearchParams;
  await vm.runInContext('initialSelection(sequence)', context);
  assert.equal(vm.runInContext('current===file', context), true);
});
