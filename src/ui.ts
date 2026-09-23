import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { Profile, ProfileNode, SourceRange, SymbolRef } from './model';

/** All times in this UI are inclusive trace elapsed times, not CPU samples. */
export interface LineTiming {
  file: string;
  line: number;
  durationMs: number;
  nodeIds: string[];
  representativeId: string;
}

function fileKey(file: string): string {
  const result = path.resolve(file);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

/** Union rather than sum: nested trace nodes often describe the same elapsed time. */
export function unionDuration(intervals: Array<[number, number]>): number {
  const ordered = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start = 0;
  let end = -Infinity;
  for (const interval of ordered) {
    if (interval[0] > end) {
      if (end !== -Infinity) { total += end - start; }
      [start, end] = interval;
    } else {
      end = Math.max(end, interval[1]);
    }
  }
  return total + (end === -Infinity ? 0 : end - start);
}

/** Each bar belongs to the start of an exact recorded syntax range. */
export function groupLineTimings(nodes: ProfileNode[]): LineTiming[] {
  const groups = new Map<string, ProfileNode[]>();
  const tactics = new Map<string, SourceRange[]>();
  const compare = (a: { line: number; character: number }, b: { line: number; character: number }) => a.line - b.line || a.character - b.character;
  for (const node of nodes) {
    if (node.source && node.sourceKind === 'exact' && node.category === 'Source.tactic') {
      const key = fileKey(node.source.file);
      const values = tactics.get(key) ?? [];
      values.push({ ...node.source }); tactics.set(key, values);
    }
  }
  // Union ranges and use binary search so large imported recordings do not require quadratic work.
  for (const [key, ranges] of tactics) {
    ranges.sort((a, b) => compare(a.start, b.start));
    const merged: SourceRange[] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && compare(range.start, last.end) <= 0) {
        if (compare(range.end, last.end) > 0) { last.end = range.end; }
      } else { merged.push(range); }
    }
    tactics.set(key, merged);
  }
  const overlapsTactic = (range: SourceRange) => {
    const ranges = tactics.get(fileKey(range.file)) ?? [];
    let low = 0, high = ranges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compare(ranges[mid].end, range.start) <= 0) { low = mid + 1; } else { high = mid; }
    }
    return low < ranges.length && compare(ranges[low].start, range.end) < 0;
  };
  for (const node of nodes) {
    if (!node.source || node.sourceKind !== 'exact' || !Number.isFinite(node.durationMs) || node.durationMs <= 0) { continue; }
    if (node.category !== 'Source.tactic' && node.category !== 'Source.term') { continue; }
    // A sequence spans several statements but starts on the first one's line. Charging it there
    // would make `funext` appear to include the following expensive `exact`.
    if (node.category === 'Source.tactic' && (/Lean\.Parser\.Tactic\.tacticSeq\w*\b/.test(node.label)
      || (/Lean\.Parser\.Tactic\.seq1?\b/.test(node.label) && node.source.start.line !== node.source.end.line))) { continue; }
    // Single-source macro expansions such as `funext` become seq1 and retain their exact range;
    // these must remain eligible, otherwise the originating statement loses its only event.
    // The `by` term contains the complete proof. Its child tactics provide the more useful bars.
    // Likewise, don't overlay every argument expression on top of its enclosing tactic.
    if (node.category === 'Source.term' && overlapsTactic(node.source)) { continue; }
    const key = `${fileKey(node.source.file)}\0${node.source.start.line}`;
    const values = groups.get(key) ?? [];
    values.push(node);
    groups.set(key, values);
  }
  return [...groups.values()].map(values => {
    values.sort((a, b) => b.durationMs - a.durationMs || a.startMs - b.startMs);
    const representative = values[0];
    return {
      file: representative.source!.file,
      line: representative.source!.start.line,
      durationMs: unionDuration(values.map(node => [node.startMs, node.startMs + node.durationMs])),
      nodeIds: values.map(node => node.id),
      representativeId: representative.id,
    };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) { return `${(ms / 1000).toFixed(2)} s`; }
  if (ms >= 100) { return `${ms.toFixed(0)} ms`; }
  if (ms >= 1) { return `${ms.toFixed(1)} ms`; }
  return `${ms.toFixed(3)} ms`;
}

function timingBar(durationMs: number, maximumMs: number): string {
  return '━'.repeat(Math.max(1, Math.min(12, Math.round(12 * durationMs / Math.max(0.001, maximumMs)))));
}

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function commandLink(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function sourceRange(source: SourceRange): vscode.Range {
  return new vscode.Range(source.start.line, source.start.character, source.end.line, source.end.character);
}

function shortLabel(node: ProfileNode): string {
  const text = node.label || node.category;
  return text.split('\n')[0].replace(/\s+/g, ' ').slice(0, 140);
}

class ProfileTree implements vscode.TreeDataProvider<ProfileNode> {
  private readonly changed = new vscode.EventEmitter<ProfileNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private nodes = new Map<string, ProfileNode>();
  private children = new Map<string | null, ProfileNode[]>();
  private rootDuration = 0;

  setProfile(profile?: Profile): void {
    this.nodes = new Map(profile?.nodes.map(node => [node.id, node]) ?? []);
    this.children.clear();
    for (const node of this.nodes.values()) {
      const parent = node.parentId !== null && this.nodes.has(node.parentId) ? node.parentId : null;
      const siblings = this.children.get(parent) ?? [];
      siblings.push(node);
      this.children.set(parent, siblings);
    }
    for (const siblings of this.children.values()) { siblings.sort((a, b) => b.durationMs - a.durationMs || a.startMs - b.startMs); }
    this.rootDuration = unionDuration((this.children.get(null) ?? []).map(node => [node.startMs, node.startMs + node.durationMs]));
    this.changed.fire(undefined);
  }

  getChildren(node?: ProfileNode): ProfileNode[] { return this.children.get(node?.id ?? null) ?? []; }
  getParent(node: ProfileNode): ProfileNode | undefined { return node.parentId === null ? undefined : this.nodes.get(node.parentId); }
  getTreeItem(node: ProfileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(shortLabel(node), this.getChildren(node).length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = `${formatDuration(node.durationMs)} · ${formatDuration(node.selfMs)} self`;
    const percent = this.rootDuration > 0 ? (100 * node.durationMs / this.rootDuration).toFixed(1) : '0';
    item.tooltip = new vscode.MarkdownString();
    item.tooltip.appendMarkdown(`**${formatDuration(node.durationMs)} inclusive** · ${formatDuration(node.selfMs)} self · ${percent}% of recorded root interval\n\n`);
    item.tooltip.appendText(node.detail || node.label);
    if (node.source) {
      item.tooltip.appendMarkdown(`\n\n${node.sourceKind === 'exact' ? 'Recorded syntax' : 'Enclosing syntax'}: `);
      item.tooltip.appendText(`${path.basename(node.source.file)}:${node.source.start.line + 1}`);
    }
    item.iconPath = new vscode.ThemeIcon(node.category.startsWith('Meta') ? 'flame' : node.category.startsWith('Kernel') ? 'check' : 'symbol-method');
    item.command = { command: 'leanSourceProfiler.inspectNode', title: 'Inspect recorded operation', arguments: [node.id] };
    item.contextValue = 'leanProfileNode';
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}

export class ProfileUI implements vscode.Disposable, vscode.CodeLensProvider {
  private profile?: Profile;
  private nodes = new Map<string, ProfileNode>();
  private lines: LineTiming[] = [];
  private readonly tree = new ProfileTree();
  private readonly view: vscode.TreeView<ProfileNode>;
  private panel?: vscode.WebviewPanel;
  private selectedId?: string;
  private overlayEnabled = true;
  private readonly codeLensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.codeLensChanged.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly bars: vscode.TextEditorDecorationType;
  private readonly selection: vscode.TextEditorDecorationType;
  private readonly contextBar: vscode.TextEditorDecorationType;
  private readonly status: vscode.StatusBarItem;
  private symbolContext?: { nodeId: string; symbol: SymbolRef };
  private staleFiles = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bars = vscode.window.createTextEditorDecorationType({ isWholeLine: true, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
    this.selection = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'), border: '1px solid', borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
    this.contextBar = vscode.window.createTextEditorDecorationType({ isWholeLine: true, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = 'leanSourceProfiler.toggleOverlay';
    this.status.name = 'Lean source profile';
    this.view = vscode.window.createTreeView('leanSourceProfiler.profile', { treeDataProvider: this.tree, showCollapseAll: true });
    this.view.message = 'Profile a Lean file, or open a saved recording.';
    this.disposables.push(this.bars, this.selection, this.contextBar, this.status, this.tree, this.view, this.codeLensChanged);
    this.disposables.push(
      vscode.languages.registerCodeLensProvider([{ language: 'lean4', scheme: 'file' }, { pattern: '**/*.lean', scheme: 'file' }], this),
      vscode.commands.registerCommand('leanSourceProfiler.inspectNode', (id: unknown) => { if (typeof id === 'string') { return this.showNode(id); } }),
      vscode.commands.registerCommand('leanSourceProfiler.openSource', (id: unknown) => { if (typeof id === 'string') { return this.openNodeSource(id); } }),
      vscode.commands.registerCommand('leanSourceProfiler.openSymbol', (id: unknown, index: unknown) => { if (typeof id === 'string' && Number.isInteger(index)) { return this.openSymbol(id, Number(index)); } }),
      vscode.commands.registerCommand('leanSourceProfiler.toggleOverlay', () => this.toggleOverlay()),
      vscode.commands.registerCommand('leanSourceProfiler.clear', () => this.clear()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length && this.profile) { this.refresh(); this.renderPanel(); }
      }),
      vscode.workspace.onDidOpenTextDocument(() => this.refresh()),
    );
  }

  async showProfile(profile: Profile): Promise<void> {
    this.profile = profile;
    this.nodes = new Map(profile.nodes.map(node => [node.id, node]));
    this.lines = groupLineTimings(profile.nodes);
    this.symbolContext = undefined;
    this.selectedId = undefined;
    this.staleFiles.clear();
    this.overlayEnabled = true;
    this.tree.setProfile(profile);
    this.view.title = `Profile · ${path.basename(profile.sourceFile)}`;
    this.view.description = `${formatDuration(profile.elapsedMs)} elapsed`;
    this.view.message = 'Inclusive trace time · children sorted by cost · bars mark recorded syntax starts';
    await vscode.commands.executeCommand('setContext', 'leanSourceProfiler.hasProfile', true);
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(profile.sourceFile));
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    } catch (error) {
      void vscode.window.showWarningMessage(`Recording loaded, but its source file could not be opened: ${String(error)}`);
    }
    this.refresh();
    this.ensurePanel();
    this.renderPanel();
    if (this.staleFiles.has(fileKey(profile.sourceFile))) {
      void vscode.window.showWarningMessage('This Lean source has changed since the recording. Timing overlays are hidden until you profile it again or restore the recorded source.');
    }
  }

  async showNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) { return; }
    this.selectedId = node.id;
    this.symbolContext = undefined;
    this.ensurePanel();
    await this.openNodeSource(nodeId, true);
    this.renderPanel();
    this.refresh();
    try { await this.view.reveal(node, { select: true, focus: false, expand: 1 }); } catch { /* The user may have hidden the view. */ }
  }

  clear(): void {
    this.profile = undefined;
    this.nodes.clear();
    this.lines = [];
    this.selectedId = undefined;
    this.symbolContext = undefined;
    this.tree.setProfile();
    this.view.title = 'Profile';
    this.view.description = undefined;
    this.view.message = 'Profile a Lean file, or open a saved recording.';
    this.panel?.dispose();
    this.status.hide();
    void vscode.commands.executeCommand('setContext', 'leanSourceProfiler.hasProfile', false);
    this.refresh();
  }

  toggleOverlay(): void {
    this.overlayEnabled = !this.overlayEnabled;
    this.refresh();
    this.renderPanel();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.profile || !this.overlayEnabled || !this.isCurrent(document)) { return []; }
    const key = fileKey(document.uri.fsPath);
    const maximum = this.lines.reduce((max, line) => Math.max(max, line.durationMs), 0.001);
    return this.lines.filter(line => fileKey(line.file) === key && line.line < document.lineCount).map(line => new vscode.CodeLens(
      new vscode.Range(line.line, 0, line.line, 0),
      { title: `${timingBar(line.durationMs, maximum)}  ${formatDuration(line.durationMs)} inclusive · inspect profile`, command: 'leanSourceProfiler.inspectNode', arguments: [line.representativeId] },
    ));
  }

  private snapshot(file: string): string | undefined {
    const profile = this.profile;
    if (!profile) { return undefined; }
    const key = fileKey(file);
    if (key === fileKey(profile.sourceFile)) { return profile.sourceText; }
    for (const [name, content] of Object.entries(profile.sourceTexts ?? {})) {
      if (fileKey(name) === key) { return content; }
    }
    return undefined;
  }

  private isCurrent(document: vscode.TextDocument): boolean {
    const snapshot = this.snapshot(document.uri.fsPath);
    if (snapshot === undefined) { return false; }
    const current = snapshot === document.getText();
    const key = fileKey(document.uri.fsPath);
    if (current) { this.staleFiles.delete(key); } else { this.staleFiles.add(key); }
    return current;
  }

  private refresh(): void {
    const maximum = this.lines.reduce((max, line) => Math.max(max, line.durationMs), 0.001);
    for (const editor of vscode.window.visibleTextEditors) {
      const key = fileKey(editor.document.uri.fsPath);
      const current = this.profile && this.isCurrent(editor.document);
      const bars: vscode.DecorationOptions[] = [];
      if (current && this.overlayEnabled) {
        for (const line of this.lines) {
          if (fileKey(line.file) !== key || line.line >= editor.document.lineCount) { continue; }
          const hover = new vscode.MarkdownString();
          hover.isTrusted = { enabledCommands: ['leanSourceProfiler.inspectNode'] };
          hover.appendMarkdown(`**${formatDuration(line.durationMs)} inclusive elapsed trace time**\n\n`);
          hover.appendText('Time attributed to recorded syntax beginning on this line. Nested/overlapping events on this line are counted once. Bars on different lines can contain the same time.');
          hover.appendMarkdown(`\n\n[Inspect recorded operations](${commandLink('leanSourceProfiler.inspectNode', [line.representativeId])})`);
          bars.push({ range: new vscode.Range(line.line, 0, line.line, 0), hoverMessage: hover, renderOptions: { after: { contentText: `${timingBar(line.durationMs, maximum)}  ${formatDuration(line.durationMs)}`, color: new vscode.ThemeColor('charts.orange'), margin: '0 0 0 2em', fontWeight: '600' } } });
        }
      }
      editor.setDecorations(this.bars, bars);
      const selected = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
      editor.setDecorations(this.selection, current && this.overlayEnabled && selected?.source && fileKey(selected.source.file) === key ? [sourceRange(selected.source)] : []);
      const contextual: vscode.DecorationOptions[] = [];
      const symbol = this.symbolContext?.symbol;
      const event = this.symbolContext ? this.nodes.get(this.symbolContext.nodeId) : undefined;
      if (current && this.overlayEnabled && symbol?.kind === 'unfold' && !symbol.sourceStale && symbol.file && symbol.range && fileKey(symbol.file) === key && event) {
        const hover = new vscode.MarkdownString();
        hover.appendText(`This definition was unfolded within ${shortLabel(event)} (${formatDuration(event.durationMs)} inclusive). This is the caller's event duration, not measured time on this definition's source line.`);
        contextual.push({ range: sourceRange({ file: symbol.file, ...symbol.range }), hoverMessage: hover, renderOptions: { after: { contentText: `↳ unfolding in selected call · ${formatDuration(event.durationMs)} context`, color: new vscode.ThemeColor('charts.purple'), margin: '0 0 0 2em' } } });
      }
      editor.setDecorations(this.contextBar, contextual);
    }
    this.codeLensChanged.fire();
    if (this.profile) {
      const stale = this.staleFiles.size > 0;
      this.status.text = stale ? '$(warning) Lean profile: source changed' : `$(graph) Lean profile: ${this.overlayEnabled ? 'shown' : 'hidden'}`;
      this.status.tooltip = stale ? 'Source differs from the recording. Overlays on changed files are hidden. Profile again to update.' : 'Toggle Lean source timing overlays. Timings are inclusive and must not be added across lines.';
      this.status.show();
    }
  }

  private async openNodeSource(nodeId: string, preserveFocus = false): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node?.source) { return; }
    await this.openRange(node.source, preserveFocus);
  }

  private async openRange(source: SourceRange, preserveFocus = false): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.file));
      if (!this.isCurrent(document)) {
        const message = this.snapshot(source.file) === undefined
          ? 'This file has no recorded source snapshot. Its saved location is shown without timing overlays.'
          : 'This source file has changed. Saved locations may be stale; timing overlays are hidden.';
        void vscode.window.showWarningMessage(message);
      }
      const range = document.validateRange(sourceRange(source));
      const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus });
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.refresh();
    } catch (error) {
      void vscode.window.showWarningMessage(`Could not open recorded source: ${String(error)}`);
    }
  }

  private async openSymbol(nodeId: string, index: number): Promise<void> {
    const node = this.nodes.get(nodeId);
    const symbol = node?.symbols?.[index];
    if (!node || !symbol) { return; }
    if (symbol.sourceStale) {
      void vscode.window.showWarningMessage(`The recorded location for ${symbol.name} is unavailable because its imported source or compiled artifact could not be verified. Rebuild imports and capture a new profile to enable navigation.`);
      return;
    }
    if (!symbol.file || !symbol.range) {
      void vscode.window.showInformationMessage(`No source location was recorded for ${symbol.name}.`);
      return;
    }
    this.symbolContext = { nodeId, symbol };
    this.selectedId = nodeId;
    await this.openRange({ file: symbol.file, ...symbol.range });
    this.renderPanel();
  }

  private ensurePanel(): void {
    // Reuse the existing group. Revealing "Beside" after a click in the webview would move it
    // one group farther right on every drill-down.
    if (this.panel) { this.panel.reveal(this.panel.viewColumn, true); return; }
    this.panel = vscode.window.createWebviewPanel('leanSourceProfiler.details', 'Lean profile', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object') { return; }
      const data = message as Record<string, unknown>;
      if (data.command === 'toggle') { this.toggleOverlay(); }
      if (data.command === 'overview') { this.selectedId = undefined; this.symbolContext = undefined; this.renderPanel(); this.refresh(); }
      if (data.command === 'select' && typeof data.id === 'string') { await this.showNode(data.id); }
      if (data.command === 'source' && typeof data.id === 'string') { await this.openNodeSource(data.id); }
      if (data.command === 'symbol' && typeof data.id === 'string' && Number.isInteger(data.index)) { await this.openSymbol(data.id, Number(data.index)); }
    }, undefined, this.disposables);
  }

  private renderPanel(): void {
    if (!this.panel || !this.profile) { return; }
    const profile = this.profile;
    const selected = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    const children = this.tree.getChildren(selected);
    const breadcrumbs: ProfileNode[] = [];
    let ancestor = selected ? this.tree.getParent(selected) : undefined;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      breadcrumbs.unshift(ancestor); seen.add(ancestor.id); ancestor = this.tree.getParent(ancestor);
    }
    const denominator = selected?.durationMs ?? children.reduce((max, child) => Math.max(max, child.durationMs), 0.001);
    const stale = this.staleFiles.size > 0;
    const nonce = randomBytes(18).toString('base64');
    const source = selected?.source;
    const symbols = selected?.symbols ?? [];
    const hotLines = [...this.lines].sort((a, b) => b.durationMs - a.durationMs).slice(0, 20);
    const body = `
      <header><div><span class="eyebrow">LEAN SOURCE PROFILE</span><h1>${html(path.basename(profile.sourceFile))}</h1></div><div class="toolbar">${selected ? '<button data-action="overview" class="secondary">Overview</button>' : ''}<button data-action="toggle" class="secondary">${this.overlayEnabled ? 'Hide' : 'Show'} source bars</button></div></header>
      ${stale ? '<div class="warning" role="status">Source changed since this recording. Bars on changed files are hidden. Profile again to update.</div>' : ''}
      <div class="metrics"><div><strong>${html(formatDuration(profile.elapsedMs))}</strong><span>Lean processing</span></div>${profile.captureWallMs === undefined ? '' : `<div><strong>${html(formatDuration(profile.captureWallMs))}</strong><span>capture total, including export</span></div>`}<div><strong>${profile.nodes.length.toLocaleString()}</strong><span>recorded operations</span></div><div><strong>${html(profile.leanVersion.replace(/^Lean \(version /, '').slice(0, 48))}</strong><span>Lean version</span></div></div>
      <p class="note">Bars show inclusive elapsed trace time. Nested operations share time; do not add the bars across source lines. Work below the recording threshold may appear as self time.</p>
      ${selected ? `<nav aria-label="Call path">${breadcrumbs.slice(-6).map(node => `<button class="crumb" data-action="select" data-id="${html(node.id)}">${html(shortLabel(node))}</button><span>›</span>`).join('')}<span>${html(selected.category)}</span></nav><h2>${html(shortLabel(selected))}</h2><div class="metrics selected"><div><strong>${html(formatDuration(selected.durationMs))}</strong><span>inclusive</span></div><div><strong>${html(formatDuration(selected.selfMs))}</strong><span>self / unrecorded children</span></div></div>${source ? `<button class="source" data-action="source" data-id="${html(selected.id)}">${html(path.basename(source.file))}:${source.start.line + 1}:${source.start.character + 1} ↗</button><span class="mapping">${selected.sourceKind === 'exact' ? 'recorded syntax range' : 'inherited enclosing range'}</span>` : '<p class="note">This operation has no recorded source range.</p>'}<pre>${html(selected.detail || selected.label)}</pre>` : '<h2>Where did the time go?</h2><p>Select a timing above a Lean statement, or select an operation below. Follow its children to inspect the expressions being elaborated or reduced.</p>'}
      ${!selected && hotLines.length ? `<section><h3>Slowest source statements</h3><ul class="hot-lines">${hotLines.map(line => `<li><button data-action="select" data-id="${html(line.representativeId)}"><span>${html((this.snapshot(line.file)?.split('\n')[line.line] ?? shortLabel(this.nodes.get(line.representativeId)!)).trim())}</span><small>${html(path.basename(line.file))}:${line.line + 1}</small></button><strong>${html(formatDuration(line.durationMs))}</strong></li>`).join('')}</ul></section>` : ''}
      <section><h3>${selected ? 'Nested operations' : 'Recorded roots'} <span class="count">${children.length}</span></h3>${children.length ? `<table><thead><tr><th>Operation</th><th>Inclusive</th><th>Self</th></tr></thead><tbody>${children.map((child, index) => `<tr><td><button class="operation" data-action="select" data-id="${html(child.id)}"><span>${html(shortLabel(child))}</span><span class="bar-track"><span class="bar bar-${index}"></span></span></button></td><td>${html(formatDuration(child.durationMs))}</td><td>${html(formatDuration(child.selfMs))}</td></tr>`).join('')}</tbody></table>` : '<p class="note">No child operations were retained in this recording.</p>'}</section>
      ${symbols.length ? `<section><h3>Definitions in this operation</h3><p class="note">An expression reference is a navigation link, not a cost attribution. An unfolding link preserves this call context; it does not reassign the caller’s duration to the definition.</p>${symbols.some(symbol => symbol.sourceStale) ? '<p class="note">Some imported source locations could not be verified. Rebuild imports and capture a new profile to enable those links.</p>' : ''}<ul class="symbols">${symbols.map((symbol, index) => `<li><button ${!symbol.sourceStale && symbol.file && symbol.range ? '' : 'disabled'} ${symbol.sourceStale ? 'title="Source location unavailable until imports are rebuilt and a new profile is captured."' : ''} data-action="symbol" data-id="${html(selected!.id)}" data-index="${index}">${html(symbol.name)}${!symbol.sourceStale && symbol.file && symbol.range ? ' ↗' : ''}</button><span class="badge">${symbol.sourceStale ? 'rebuild imports' : symbol.kind === 'unfold' ? 'recorded unfolding' : 'expression reference'}</span></li>`).join('')}</ul></section>` : ''}
      <footer>${html(profile.profilePath ? path.basename(profile.profilePath) : 'Loaded recording')} · source locations refer to the recorded source snapshot</footer>`;
    this.panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Lean profile</title><style nonce="${nonce}">
      *{box-sizing:border-box}body{margin:0;padding:24px 28px 48px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.5}header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:20px}h1{font-size:21px;margin:3px 0 0;overflow-wrap:anywhere}h2{font-size:17px;margin:22px 0 12px;overflow-wrap:anywhere}h3{font-size:13px;margin:24px 0 10px}.eyebrow{font-size:10px;letter-spacing:.14em;color:var(--vscode-descriptionForeground)}button{font:inherit;cursor:pointer;color:var(--vscode-textLink-foreground);background:none;border:0;padding:0;text-align:left}button:hover{text-decoration:underline}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{cursor:default;color:var(--vscode-disabledForeground)}.secondary{border:1px solid var(--vscode-button-border,var(--vscode-panel-border));padding:6px 10px;border-radius:4px;color:var(--vscode-foreground);white-space:nowrap}.metrics{display:flex;flex-wrap:wrap;gap:24px;margin:20px 0 14px}.metrics>div{display:flex;flex-direction:column;gap:2px}.metrics strong{font-size:18px;font-weight:600}.metrics span,.note,.mapping,footer{color:var(--vscode-descriptionForeground);font-size:12px}.metrics.selected strong{font-size:24px}.note{max-width:80ch}.warning{border-left:3px solid var(--vscode-editorWarning-foreground);padding:10px 12px;background:var(--vscode-inputValidation-warningBackground);margin-top:16px}nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:11px;margin-top:24px}nav .crumb{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mapping{margin-left:12px}.source{font-family:var(--vscode-editor-font-family)}pre{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);padding:14px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}table{border-collapse:collapse;width:100%;table-layout:fixed}th{text-align:left;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:400}td,th{border-bottom:1px solid var(--vscode-panel-border);padding:8px 6px;vertical-align:middle}td:first-child,th:first-child{padding-left:0;width:auto}td:nth-child(n+2),th:nth-child(n+2){width:85px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.operation{display:block;width:100%}.operation>span:first-child{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track{display:block;height:4px;margin-top:6px;width:100%;background:var(--vscode-editor-inactiveSelectionBackground)}.bar{display:block;height:4px;background:var(--vscode-charts-orange)}.count{color:var(--vscode-descriptionForeground);font-weight:400}.symbols{list-style:none;padding:0}.symbols li{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:5px 0}.symbols button{overflow-wrap:anywhere}.badge{font-size:10px;padding:1px 5px;border:1px solid var(--vscode-panel-border);border-radius:3px;color:var(--vscode-descriptionForeground)}footer{margin-top:32px;border-top:1px solid var(--vscode-panel-border);padding-top:12px;overflow-wrap:anywhere}@media(max-width:500px){body{padding:16px}header{align-items:flex-start;flex-direction:column}.metrics{gap:18px}td:nth-child(n+2),th:nth-child(n+2){width:68px}}
      .toolbar{display:flex;gap:8px}.hot-lines{list-style:none;margin:0;padding:0}.hot-lines li{display:flex;gap:16px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--vscode-panel-border);padding:9px 0}.hot-lines button{min-width:0}.hot-lines button span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family)}.hot-lines small{display:block;color:var(--vscode-descriptionForeground);font-size:10px}.hot-lines strong{white-space:nowrap;font-weight:500;font-variant-numeric:tabular-nums}
      ${children.map((child, index) => `.bar-${index}{width:${Math.max(0.4, Math.min(100, 100 * child.durationMs / Math.max(0.001, denominator))).toFixed(2)}%}`).join('')}
      </style></head><body>${body}<script nonce="${nonce}">const vscode = acquireVsCodeApi();document.addEventListener('click',event=>{const target=event.target.closest('button[data-action]');if(!target||target.disabled)return;vscode.postMessage({command:target.dataset.action,id:target.dataset.id,index:target.dataset.index===undefined?undefined:Number(target.dataset.index)});});</script></body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables.reverse()) { disposable.dispose(); }
  }
}
