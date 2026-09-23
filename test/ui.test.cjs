const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function loadUI() {
  const dispose = () => {};
  const commands = new Map();
  const state = { html: '', panels: [], warnings: [], documents: new Map(), editor: undefined };
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
      else { this.start = a; this.end = b; }
    }
  }
  class EventEmitter { constructor() { this.event = () => ({ dispose }); } fire() {} dispose() {} }
  class MarkdownString {
    constructor() { this.value = ''; }
    appendText(text) { this.value += text; return this; }
    appendMarkdown(text) { this.value += text; return this; }
  }
  const vscode = {
    EventEmitter, Range, Selection: Range, Position, MarkdownString,
    ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class {},
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, DecorationRangeBehavior: { ClosedClosed: 1 },
    StatusBarAlignment: { Right: 1 }, ViewColumn: { One: 1, Beside: -2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    Uri: { file: fsPath => ({ fsPath }) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose }; }, executeCommand: async () => {} },
    languages: { registerCodeLensProvider: () => ({ dispose }) },
    workspace: {
      openTextDocument: async uri => { const document = state.documents.get(uri.fsPath); if (!document) throw new Error('Missing test document'); return document; },
      onDidChangeTextDocument: () => ({ dispose }), onDidOpenTextDocument: () => ({ dispose }),
    },
    window: {
      visibleTextEditors: [],
      createTextEditorDecorationType: () => ({ dispose }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose }),
      createTreeView: () => ({ reveal: async () => {}, dispose }),
      onDidChangeVisibleTextEditors: () => ({ dispose }),
      showWarningMessage: async text => { state.warnings.push(text); }, showInformationMessage: async () => {},
      showTextDocument: async document => {
        const editor = { document, decorations: new Map(), setDecorations(type, options) { this.decorations.set(type, options); }, revealRange() {} };
        state.editor = editor; vscode.window.visibleTextEditors = [editor]; return editor;
      },
      createWebviewPanel: () => {
        const panel = { reveal() {}, dispose() {}, onDidDispose: () => ({ dispose }), webview: { html: '', onDidReceiveMessage(callback) { state.message = callback; return { dispose }; } } };
        state.panels.push(panel); return panel;
      },
    },
  };
  const filename = path.join(__dirname, '..', 'src', 'ui.ts');
  const compiled = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = id => id === 'vscode' ? vscode : Module.prototype.require.call(mod, id);
  mod._compile(compiled, filename);
  return { ...mod.exports, state, vscode, commands };
}

function node(id, options = {}) {
  return {
    id, parentId: null, category: 'Source.tactic', label: 'exact proof', detail: 'exact proof',
    startMs: 0, durationMs: 10, selfMs: 1,
    sourceKind: 'exact', source: { file: '/test/Main.lean', start: { line: 2, character: 2 }, end: { line: 2, character: 13 } },
    ...options,
  };
}

function fixture(ui, text = 'theorem t : True := by\n  skip\n  exact True.intro\n') {
  const document = {
    uri: { fsPath: '/test/Main.lean' }, lineCount: 4, text,
    getText() { return this.text; }, validateRange: range => range,
  };
  ui.state.documents.set(document.uri.fsPath, document);
  const profile = { schemaVersion: 1, sourceFile: document.uri.fsPath, sourceText: text, leanVersion: '4.34.0-rc2', elapsedMs: 100, nodes: [node('a')] };
  return { document, profile };
}

test('line durations union nested and partially overlapping intervals', () => {
  const { groupLineTimings, unionDuration } = loadUI();
  assert.equal(unionDuration([[0, 10], [3, 5], [8, 15], [20, 22]]), 17);
  const bars = groupLineTimings([node('outer'), node('inner', { parentId: 'outer', startMs: 2, durationMs: 4 }), node('later', { startMs: 20, durationMs: 3 })]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].durationMs, 13);
  assert.equal(bars[0].representativeId, 'outer');
  assert.deepEqual(bars[0].nodeIds, ['outer', 'inner', 'later']);
});

test('bar selection favors tactics and excludes inherited internals', () => {
  const { groupLineTimings } = loadUI();
  const nodes = [
    node('by', { category: 'Source.term', durationMs: 100, source: { file: '/test/Main.lean', start: { line: 0, character: 19 }, end: { line: 3, character: 0 } } }),
    node('tactic'),
    node('argument', { category: 'Source.term', durationMs: 8, source: { file: '/test/Main.lean', start: { line: 2, character: 8 }, end: { line: 2, character: 13 } } }),
    node('whnf', { category: 'Meta.whnf', sourceKind: 'inherited', durationMs: 500 }),
  ];
  const bars = groupLineTimings(nodes);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].durationMs, 10);
  assert.deepEqual(bars[0].nodeIds, ['tactic']);
});

test('multiline tactics get one bar at the exact syntax start', () => {
  const { groupLineTimings } = loadUI();
  const bars = groupLineTimings([node('a', { source: { file: '/test/Main.lean', start: { line: 2, character: 2 }, end: { line: 5, character: 20 } } })]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].line, 2);
});

test('structural sequence and command wrappers never charge an entire proof to its first tactic', () => {
  const { groupLineTimings } = loadUI();
  const proofRange = { file: '/test/Main.lean', start: { line: 2, character: 2 }, end: { line: 3, character: 26 } };
  const nodes = [
    node('command', { category: 'Elab.command', durationMs: 103, source: proofRange }),
    node('async', { category: 'Elab.async', durationMs: 102, source: proofRange }),
    node('seq', { label: 'Source.tactic: Lean.Parser.Tactic.tacticSeq', durationMs: 101, source: proofRange }),
    node('indented', { label: 'Source.tactic: Lean.Parser.Tactic.tacticSeq1Indented', durationMs: 100.9, source: proofRange }),
    node('multiSeq1', { label: 'Source.tactic: Lean.Parser.Tactic.seq1', durationMs: 100.8, source: proofRange }),
    node('funext', { label: 'Source.tactic: Lean.Parser.Tactic.seq1', durationMs: 0.2 }),
    node('exact', { startMs: 0.5, durationMs: 100, source: { file: '/test/Main.lean', start: { line: 3, character: 2 }, end: { line: 3, character: 26 } } }),
  ];
  const bars = groupLineTimings(nodes);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].line, 2);
  assert.equal(bars[0].durationMs, 0.2);
  assert.equal(bars[0].representativeId, 'funext');
  assert.equal(bars[1].durationMs, 100);
});

test('changed source suppresses CodeLens and bars, restoring source restores them', async () => {
  const ui = loadUI();
  const { document, profile } = fixture(ui);
  const presentation = new ui.ProfileUI({});
  await presentation.showProfile(profile);
  assert.equal(presentation.provideCodeLenses(document).length, 1);
  assert.ok([...ui.state.editor.decorations.values()].some(value => value.length === 1));
  document.text += '-- changed';
  presentation.refresh();
  assert.equal(presentation.provideCodeLenses(document).length, 0);
  assert.ok([...ui.state.editor.decorations.values()].every(value => value.length === 0));
  document.text = profile.sourceText;
  presentation.refresh();
  assert.equal(presentation.provideCodeLenses(document).length, 1);
  presentation.toggleOverlay();
  assert.equal(presentation.provideCodeLenses(document).length, 0);
  presentation.clear();
  assert.equal(presentation.provideCodeLenses(document).length, 0);
  presentation.dispose();
});

test('clickable CodeLens bars remain visible at syntax starts and scale proportionally', async () => {
  const ui = loadUI();
  const { document, profile } = fixture(ui);
  profile.nodes = [100, 25, 0.01].map((durationMs, line) => node(String(line), {
    durationMs, source: { file: document.uri.fsPath, start: { line, character: 2 }, end: { line, character: 15 } },
  }));
  const presentation = new ui.ProfileUI({});
  await presentation.showProfile(profile);
  const lenses = presentation.provideCodeLenses(document);
  assert.deepEqual(lenses.map(lens => lens.command.title.match(/^━+/)[0].length), [12, 3, 1]);
  assert.deepEqual(lenses.map(lens => lens.range.start.line), [0, 1, 2]);
  assert.ok(lenses.every(lens => lens.command.command === 'leanSourceProfiler.inspectNode'));
  presentation.dispose();
});

test('selected operation puts nested costs before definition links', async () => {
  const ui = loadUI();
  const { profile } = fixture(ui);
  profile.nodes[0].symbols = [{ name: 'Nat.add_zero', kind: 'reference' }];
  profile.nodes.push(node('child', { parentId: 'a', durationMs: 3, category: 'Meta.whnf', sourceKind: 'inherited' }));
  const presentation = new ui.ProfileUI({});
  await presentation.showProfile(profile);
  await presentation.showNode('a');
  const rendered = ui.state.panels[0].webview.html;
  assert.ok(rendered.indexOf('Nested operations') < rendered.indexOf('Definitions in this operation'));
  assert.ok(rendered.includes('Lean processing'));
  assert.ok(!rendered.includes('frontend elapsed'));
  presentation.dispose();
});

test('recorded source and expression strings are escaped in details, CSP permits no external content', async () => {
  const ui = loadUI();
  const { profile } = fixture(ui);
  profile.nodes[0].detail = '</pre><script>globalThis.attacked = true</script>';
  const presentation = new ui.ProfileUI({});
  await presentation.showProfile(profile);
  await presentation.showNode('a');
  const rendered = ui.state.panels[0].webview.html;
  assert.ok(rendered.includes('&lt;/pre&gt;&lt;script&gt;globalThis.attacked = true&lt;/script&gt;'));
  assert.equal((rendered.match(/<script\b/g) ?? []).length, 1);
  assert.ok(rendered.includes("default-src 'none'"));
  assert.ok(!rendered.includes('style="'));
  await ui.state.message({ command: 'source', id: '/etc/passwd' });
  assert.equal(ui.state.editor.document.uri.fsPath, '/test/Main.lean');
  presentation.dispose();
});

test('reference navigation never paints an unfolding cost annotation', async () => {
  const ui = loadUI();
  const { profile } = fixture(ui);
  const imported = { uri: { fsPath: '/test/Imported.lean' }, lineCount: 1, getText: () => 'def imported := 1\n', validateRange: range => range };
  ui.state.documents.set(imported.uri.fsPath, imported);
  profile.sourceTexts = { [imported.uri.fsPath]: imported.getText() };
  profile.nodes[0].symbols = [{ name: 'imported', file: imported.uri.fsPath, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } }, kind: 'reference' }];
  const presentation = new ui.ProfileUI({});
  await presentation.showProfile(profile);
  await ui.commands.get('leanSourceProfiler.openSymbol')('a', 0);
  assert.equal(ui.state.editor.document.uri.fsPath, imported.uri.fsPath);
  assert.ok([...ui.state.editor.decorations.values()].every(value => value.length === 0));
  profile.nodes[0].symbols[0].kind = 'unfold';
  await ui.commands.get('leanSourceProfiler.openSymbol')('a', 0);
  assert.ok([...ui.state.editor.decorations.values()].some(value => value[0]?.renderOptions?.after?.contentText.includes('context')));
  presentation.dispose();
});

test('stale imported declaration metadata never navigates to its former source range', async () => {
  const ui = loadUI();
  const { profile } = fixture(ui);
  const imported = { uri: { fsPath: '/test/Imported.lean' }, lineCount: 20, getText: () => 'def changed := 2\n', validateRange: range => range };
  ui.state.documents.set(imported.uri.fsPath, imported);
  profile.sourceTexts = { [imported.uri.fsPath]: imported.getText() };
  // Preserve an old range deliberately: the UI must guard the flag independently of sanitization.
  profile.nodes[0].symbols = [{ name: 'imported', file: imported.uri.fsPath, range: { start: { line: 10, character: 0 }, end: { line: 10, character: 17 } }, kind: 'unfold', sourceStale: true }];
  const presentation = new ui.ProfileUI({});
  await presentation.showProfile(profile);
  await presentation.showNode('a');
  const rendered = ui.state.panels[0].webview.html;
  assert.ok(rendered.includes('rebuild imports'));
  assert.ok(rendered.includes('<button disabled title="Source location unavailable until imports are rebuilt'));
  await ui.commands.get('leanSourceProfiler.openSymbol')('a', 0);
  assert.equal(ui.state.editor.document.uri.fsPath, '/test/Main.lean');
  assert.equal(presentation.symbolContext, undefined);
  assert.ok(ui.state.warnings.some(message => message.includes('Rebuild imports')));
  presentation.dispose();
});
