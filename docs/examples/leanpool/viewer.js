'use strict';
(() => {
  const canonical = file => String(file || '').replace(/\\/g, '/');
  const basename = file => canonical(file).split('/').filter(Boolean).pop() || file;
  const duration = ms => ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(3)} ms`;
  const percent = (part, whole) => whole > 0 ? Math.max(0, 100 * part / whole) : 0;
  const within = (file, folder) => !folder || file === folder || file.startsWith(`${folder}/`);
  function apiRoute(route, published = false) {
    if (!published) return route;
    if (route === '/api/session') return './data/session.json';
    if (route === '/api/index') return './data/index.json';
    const match = /^\/api\/file\?id=(0|[1-9]\d*)$/.exec(route);
    if (match) return `./data/files/${match[1]}.json.gz`;
    throw new Error('Unknown published recording resource.');
  }
  function intervalUnion(intervals) {
    const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0]);
    let sum = 0, start = 0, end = -Infinity;
    for (const interval of sorted) {
      if (interval[0] > end) { if (end !== -Infinity) sum += end - start; [start, end] = interval; }
      else end = Math.max(end, interval[1]);
    }
    return sum + (end === -Infinity ? 0 : end - start);
  }
  function sourceLineTimings(nodes, sourceFile) {
    const file = canonical(sourceFile);
    const matching = nodes.filter(node => node.source && canonical(node.source.file) === file && node.sourceKind === 'exact');
    const compare = (a, b) => a.line - b.line || a.character - b.character;
    const ranges = matching.filter(node => node.category === 'Source.tactic').map(node => ({ ...node.source })).sort((a, b) => compare(a.start, b.start));
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && compare(range.start, last.end) <= 0) { if (compare(range.end, last.end) > 0) last.end = range.end; }
      else merged.push(range);
    }
    const overlapsTactic = range => {
      let low = 0, high = merged.length;
      while (low < high) { const middle = (low + high) >>> 1; if (compare(merged[middle].end, range.start) <= 0) low = middle + 1; else high = middle; }
      return low < merged.length && compare(merged[low].start, range.end) < 0;
    };
    const grouped = new Map();
    for (const node of matching) {
      if (!(node.durationMs > 0) || !['Source.tactic', 'Source.term'].includes(node.category)) continue;
      if (node.category === 'Source.tactic' && (/Lean\.Parser\.Tactic\.tacticSeq\w*\b/.test(node.label) || (/Lean\.Parser\.Tactic\.seq1?\b/.test(node.label) && node.source.start.line !== node.source.end.line))) continue;
      if (node.category === 'Source.term' && overlapsTactic(node.source)) continue;
      const values = grouped.get(node.source.start.line) || [];
      values.push(node); grouped.set(node.source.start.line, values);
    }
    return [...grouped.entries()].map(([line, values]) => {
      values.sort((a, b) => b.durationMs - a.durationMs);
      return { line, durationMs: intervalUnion(values.map(node => [node.startMs, node.startMs + node.durationMs])), nodeId: values[0].id, nodeIds: values.map(node => node.id) };
    }).sort((a, b) => a.line - b.line);
  }
  function folderTotals(files, folder = '') {
    const subset = files.filter(file => within(file.path, folder));
    return { count: subset.length, captured: subset.filter(file => file.status === 'ok').length, failed: subset.filter(file => file.status !== 'ok').length, durationMs: subset.reduce((sum, file) => sum + (file.status === 'ok' ? file.elapsedMs || 0 : 0), 0) };
  }
  function folderChildren(files, folder = '') {
    const folders = new Map(), result = [];
    const prefix = folder ? `${folder}/` : '';
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length), slash = rest.indexOf('/');
      if (slash < 0) result.push({ kind: 'file', name: rest, path: file.path, durationMs: file.status === 'ok' ? file.elapsedMs || 0 : 0, file });
      else {
        const name = rest.slice(0, slash), key = `${prefix}${name}`;
        const entry = folders.get(key) || { kind: 'folder', name, path: key, durationMs: 0, count: 0, failed: 0 };
        entry.durationMs += file.status === 'ok' ? file.elapsedMs || 0 : 0;
        entry.count++; if (file.status !== 'ok') entry.failed++;
        folders.set(key, entry);
      }
    }
    return [...folders.values(), ...result].sort((a, b) => b.durationMs - a.durationMs || a.name.localeCompare(b.name));
  }
  function aggregateOperations(nodes, eventIds) {
    const byId = new Map(nodes.map(node => [node.id, node])), selected = new Set(eventIds), memo = new Map();
    const hasSelectedAncestor = node => {
      const visited = [];
      let parent = node.parentId, found = false;
      while (parent !== null && byId.has(parent)) {
        if (selected.has(parent)) { found = true; break; }
        if (memo.has(parent)) { found = memo.get(parent); break; }
        visited.push(parent); parent = byId.get(parent).parentId;
      }
      for (const id of visited) memo.set(id, found);
      return found;
    };
    return [...selected].map(id => byId.get(id)).filter(node => node && !hasSelectedAncestor(node)).sort((a, b) => b.durationMs - a.durationMs);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { intervalUnion, sourceLineTimings, folderTotals, folderChildren, aggregateOperations, percent, duration, within, apiRoute };
  if (typeof document === 'undefined') return;
  const published = document.documentElement.dataset.recordingMode === 'static';

  const $ = id => document.getElementById(id);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className, action) => { const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node; };
  const link = (text, url, className) => { const node = element('a', className, text); node.href = url; return node; };
  const progress = (value, className = '') => { const node = element('progress', className); node.max = 100; node.value = Math.min(100, value); node.setAttribute('aria-label', `${value.toFixed(1)}%`); return node; };
  const state = { session: null, folder: '', mode: 'folders', filter: '', profile: null, file: null, selected: null, aggregate: null, sourceFile: null, sourceContext: null, nodes: new Map(), children: new Map(), index: null, request: 0, limit: 150 };
  const cache = new Map();
  let toastTimer;
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
  async function api(route) {
    const resource = apiRoute(route, published);
    const response = await fetch(resource, { credentials: 'same-origin' });
    if (published && resource.endsWith('.gz')) {
      if (!response.ok) throw new Error(`Recording download failed (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A static host can serve gzip as a file or transparently decode it.
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(bytes));
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed recordings. Use a current Chrome, Firefox, or Safari browser.');
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }
  function navigate(values) { const hash = new URLSearchParams(values).toString(); if (location.hash.slice(1) === hash) void route(); else location.hash = hash; }
  const goFolder = folder => navigate(folder ? { folder } : {});
  const goFile = (file, event, aggregate) => navigate({ file: file.id, ...(event ? { event } : {}), ...(aggregate ? { aggregate: aggregate.kind, name: aggregate.name, line: String(aggregate.line || '') } : {}) });
  function setNotice(message, warning = false) { const node = $('notice'); node.textContent = message; node.hidden = !message; node.classList.toggle('warning', warning); }
  function showError(error) { setNotice(error.message || String(error), true); $('content').replaceChildren(element('div', 'empty', 'This recording could not be opened.')); }
  function stat(value, label, detail) {
    const node = element('div', 'stat'); node.append(element('strong', '', value), element('span', '', label));
    if (detail) node.append(element('small', '', detail));
    return node;
  }
  function statusBadge(status) { return element('span', `status status-${status}`, status === 'complete' ? 'Complete recording' : status === 'partial' ? 'Partial recording' : 'Cancelled recording'); }
  function breadcrumbs(folder, file) {
    const target = $('breadcrumbs'); target.replaceChildren(button(basename(state.session.projectRoot), 'crumb', () => goFolder('')));
    let path = '';
    for (const part of folder.split('/').filter(Boolean)) {
      path += `${path ? '/' : ''}${part}`; const current = path;
      target.append(element('span', 'crumb-separator', '/'), button(part, 'crumb', () => goFolder(current)));
    }
    if (file) target.append(element('span', 'crumb-separator', '/'), element('span', 'crumb-current', basename(file.path)));
  }
  function renderSidebar() {
    const target = $('folder-tree'); target.replaceChildren();
    const activeFolder = state.file ? state.file.path.split('/').slice(0, -1).join('/') : state.folder;
    const root = button('', `tree-row ${!activeFolder ? 'active' : ''}`, () => goFolder(''));
    root.append(element('span', 'tree-icon', '⌂'), element('span', 'tree-label', 'All files'), element('span', 'tree-count', String(state.session.files.length)));
    target.append(root);
    const folderNames = new Set();
    for (const file of state.session.files) {
      const parts = file.path.split('/'); let folder = '';
      for (let index = 0; index < parts.length - 1; index++) { folder += `${folder ? '/' : ''}${parts[index]}`; folderNames.add(folder); }
    }
    for (const folder of [...folderNames].sort()) {
      const parts = folder.split('/'), parent = parts.slice(0, -1).join('/');
      // Expand just the selected path. The table remains the primary repository navigation.
      if (parts.length > 1 && !within(activeFolder, parent)) continue;
      const row = button('', `tree-row indent-${Math.min(parts.length - 1, 8)} ${activeFolder === folder ? 'active' : ''}`, () => goFolder(folder));
      row.title = folder;
      row.append(element('span', 'tree-icon', '▱'), element('span', 'tree-label', parts.at(-1)), element('span', 'tree-count', String(folderTotals(state.session.files, folder).count)));
      target.append(row);
    }
  }
  function rowLabel(row, action) {
    const control = button('', 'entry-name', action);
    const icon = row.kind === 'folder' ? '▱' : row.kind === 'file' ? 'λ' : row.kind === 'declaration' ? '◇' : '↳';
    control.append(element('span', `entry-icon ${row.kind}`, icon));
    const text = element('span', 'entry-text'); text.append(element('strong', '', row.name));
    if (row.kind === 'folder') text.append(element('small', '', `${row.count} file${row.count === 1 ? '' : 's'}${row.failed ? ` · ${row.failed} failed` : ''}`));
    if (row.kind === 'declaration' || row.kind === 'tactic') text.append(element('small', '', `${row.path}${row.line ? `:${row.line}` : ''}`));
    if (row.file?.status !== undefined && row.file.status !== 'ok') text.append(element('small', 'error-text', 'Capture failed · inspect error'));
    control.append(text); return control;
  }
  function timingTable(rows, folderDuration, projectDuration, onSelect) {
    const table = element('table', 'timing-table');
    const header = element('tr');
    for (const title of ['Name', 'Time', 'Of this folder', 'Of all files']) header.append(element('th', '', title));
    const head = element('thead'); head.append(header); table.append(head);
    const body = element('tbody');
    for (const row of rows) {
      const tr = element('tr'), name = element('td'); name.append(rowLabel(row, () => onSelect(row))); tr.append(name);
      tr.append(element('td', 'duration-cell', row.file?.status === 'error' ? '—' : duration(row.durationMs)));
      const folderCell = element('td', 'share-cell'); folderCell.append(progress(percent(row.durationMs, folderDuration)), element('span', '', `${percent(row.durationMs, folderDuration).toFixed(1)}%`)); tr.append(folderCell);
      tr.append(element('td', 'project-share', `${percent(row.durationMs, projectDuration).toFixed(1)}%`)); body.append(tr);
    }
    table.append(body); return table;
  }
  async function renderFolder() {
    const totals = folderTotals(state.session.files, state.folder), all = folderTotals(state.session.files);
    const projectRoot = canonical(state.session.projectRoot).replace(/\/$/, ''), target = canonical(state.session.target).replace(/\/$/, '');
    const captureScope = target === projectRoot ? 'Entire project' : target.startsWith(`${projectRoot}/`) ? target.slice(projectRoot.length + 1) : basename(target);
    $('page-title').textContent = state.folder ? basename(state.folder) : basename(state.session.projectRoot);
    $('page-subtitle').textContent = `Capture scope: ${captureScope} · ${state.folder || 'Follow the time from folders to files, then into a proof.'}`;
    $('header-actions').replaceChildren(statusBadge(state.session.status));
    const planned = state.folder ? totals.count : state.session.plannedFileCount ?? totals.count;
    const captureStatus = [totals.failed ? `${totals.failed} failed` : '', planned > totals.count ? `${planned - totals.count} not captured` : ''].filter(Boolean).join(' · ') || 'All selected files succeeded';
    $('stats').replaceChildren(stat(duration(totals.durationMs), 'Sum of file time', 'Imports + elaboration, once per captured file'), stat(`${totals.captured} / ${planned}`, 'Files captured', captureStatus), stat(`${percent(totals.durationMs, all.durationMs).toFixed(1)}%`, 'Of this recording', `${duration(state.session.wallMs)} total session wall time`));
    setNotice(state.session.status !== 'complete' ? 'This recording is incomplete. Totals include only files captured successfully; failed or unvisited files have no measured time.' : 'Folder time is the sum of captured file times. Shared imports can be counted in more than one file; this is not a parallel build timeline.');
    breadcrumbs(state.folder); renderSidebar();
    const content = $('content'); content.replaceChildren();
    const toolbar = element('div', 'table-toolbar'), tabs = element('div', 'tabs');
    for (const [mode, title] of [['folders', 'Folders & files'], ['declaration', 'Declarations'], ['tactic', 'Tactics']]) {
      const tab = button(title, `tab ${state.mode === mode ? 'selected' : ''}`, () => { state.mode = mode; state.limit = 150; void renderFolder(); });
      tab.setAttribute('aria-pressed', String(state.mode === mode)); tabs.append(tab);
    }
    const search = element('input', 'search'); search.type = 'search'; search.placeholder = 'Filter by name or path'; search.value = state.filter; search.setAttribute('aria-label', 'Filter names and paths');
    search.addEventListener('input', () => { state.filter = search.value; state.limit = 150; void renderRows(); });
    toolbar.append(tabs, search); content.append(toolbar);
    const tableContainer = element('div', 'table-container'); content.append(tableContainer);
    if (state.mode !== 'folders') content.append(element('p', 'table-note', 'Declaration and tactic times are inclusive. Nested entries can overlap; their percentages must not be added.'));
    const renderRows = async () => {
      const mode = state.mode, folder = state.folder;
      let rows;
      if (mode === 'folders') rows = folderChildren(state.session.files, folder);
      else {
        tableContainer.replaceChildren(element('div', 'loading', 'Reading the operation index…'));
        try { state.index ??= await api('/api/index'); } catch (error) { tableContainer.replaceChildren(element('div', 'empty error-text', error.message)); return; }
        if (mode !== state.mode || folder !== state.folder || state.file) return;
        rows = state.index.filter(row => row.kind === mode && within(row.path, folder));
        rows.sort((a, b) => b.durationMs - a.durationMs);
      }
      const query = state.filter.toLocaleLowerCase();
      rows = rows.filter(row => !query || `${row.name} ${row.path} ${row.declaration || ''}`.toLocaleLowerCase().includes(query));
      if (!rows.length) { tableContainer.replaceChildren(element('div', 'empty', query ? 'No matching entries in this folder.' : 'No recorded entries in this folder.')); return; }
      tableContainer.replaceChildren(timingTable(rows.slice(0, state.limit), totals.durationMs, all.durationMs, row => {
        if (row.kind === 'folder') goFolder(row.path);
        else { const file = row.file || state.session.files.find(candidate => candidate.path === row.path); if (file) goFile(file, row.eventId, row.kind === 'declaration' || row.kind === 'tactic' ? row : undefined); }
      }));
      if (rows.length > state.limit) tableContainer.append(button(`Show more (${rows.length - state.limit} remaining)`, 'load-more', () => { state.limit += 150; void renderRows(); }));
    };
    await renderRows();
  }
  function snapshot(file) { if (canonical(file) === canonical(state.profile.sourceFile)) return state.profile.sourceText; return state.profile.sourceTexts?.[file]; }
  function displayLabel(node) {
    if (node.category.startsWith('Source.') && node.source) {
      const text = snapshot(node.source.file), line = text?.split(/\r?\n/)[node.source.start.line];
      if (line !== undefined) return line.slice(node.source.start.character).trim() || node.label;
    }
    return node.label || node.category;
  }
  function selectNode(id) { if (!state.nodes.has(id)) return; goFile(state.file, id); }
  function renderSource() {
    const panel = $('source-panel'); if (!panel) return;
    const file = state.sourceFile || state.profile.sourceFile, text = snapshot(file);
    panel.replaceChildren();
    const heading = element('div', 'pane-heading'); heading.append(element('strong', '', basename(file)), element('span', 'pill', 'Recorded source')); panel.append(heading);
    if (canonical(file) !== canonical(state.profile.sourceFile)) {
      const context = state.sourceContext;
      const info = element('div', 'source-context');
      info.append(button('← Back to profiled file', 'text-button', () => { state.sourceFile = state.profile.sourceFile; state.sourceContext = null; renderSource(); }));
      if (context) info.append(element('p', '', context.symbol.kind === 'unfold' ? `This definition was unfolded within the selected ${duration(context.node.durationMs)} operation. That duration belongs to the call; no per-line time is measured in this imported definition.` : 'This definition appears in the selected expression. A reference provides navigation, not a measured cost.'));
      const recorded = state.session.files.find(entry => entry.status === 'ok' && canonical(entry.sourceFile) === canonical(file));
      if (recorded) info.append(button('Open this file’s own profile ↗', 'text-button', async () => {
        try {
          state.index ??= await api('/api/index');
          const declaration = state.index.find(row => row.kind === 'declaration' && row.path === recorded.path && row.name === context?.symbol.name);
          goFile(recorded, declaration?.eventId, declaration);
        } catch (error) { toast(error.message || String(error)); }
      }));
      panel.append(info);
    }
    if (text === undefined) { panel.append(element('div', 'empty', published ? 'This definition’s source was not included in the published recording.' : 'This definition’s source was not stored in the recording. Open the recording in VS Code to inspect available source.')); return; }
    const lines = text.split(/\r?\n/), timings = sourceLineTimings(state.profile.nodes, file), byLine = new Map(timings.map(timing => [timing.line, timing]));
    const maximum = timings.reduce((max, timing) => Math.max(max, timing.durationMs), .001);
    const code = element('div', 'source-code'); code.setAttribute('aria-label', `Recorded source: ${basename(file)}`);
    const aggregateSource = state.aggregate?.line ? { file: state.profile.sourceFile, start: { line: state.aggregate.line - 1, character: 0 }, end: { line: (state.aggregate.endLine || state.aggregate.line) - 1, character: 0 } } : null;
    const selectedSource = state.sourceContext?.symbol.range ? { file, ...state.sourceContext.symbol.range } : aggregateSource || state.selected?.source;
    let scrollTarget;
    for (let line = 0; line < lines.length; line++) {
      const timing = byLine.get(line), selected = selectedSource && canonical(selectedSource.file) === canonical(file) && line >= selectedSource.start.line && line <= selectedSource.end.line;
      const row = timing ? button('', `source-line has-timing${selected ? ' highlighted' : ''}`, () => selectNode(timing.nodeId)) : element('div', `source-line${selected ? ' highlighted' : ''}`);
      row.dataset.line = String(line + 1);
      if (timing) row.title = `${duration(timing.durationMs)} inclusive elapsed time. Click to inspect. Overlapping events on this line are counted once.`;
      const number = element('span', 'line-number', String(line + 1)); number.setAttribute('aria-hidden', 'true');
      const source = element('code', 'source-text', lines[line] || ' '); source.title = lines[line];
      const meter = element('span', 'source-timing');
      if (timing) meter.append(progress(percent(timing.durationMs, maximum)), element('span', '', duration(timing.durationMs)));
      else if (state.sourceContext?.symbol.kind === 'unfold' && line === state.sourceContext.symbol.range?.start.line) { meter.append(element('span', 'context-mark', '↳ in selected call')); meter.title = 'A recorded unfolding occurred in this call context. This is not measured time on the definition line.'; }
      row.append(number, source, meter); code.append(row);
      if (selected && !scrollTarget) scrollTarget = row;
    }
    panel.append(code);
    // source-code is the positioned offset parent; offsetTop is already local to it.
    if (scrollTarget) requestAnimationFrame(() => { if (scrollTarget.isConnected) code.scrollTop = Math.max(0, scrollTarget.offsetTop - code.clientHeight / 3); });
  }
  function renderDetail() {
    const panel = $('detail-panel'); if (!panel) return;
    panel.replaceChildren();
    const node = state.selected, aggregate = state.aggregate;
    const aggregateChildren = aggregate ? aggregateOperations(state.profile.nodes, aggregate.eventIds || (aggregate.eventId ? [aggregate.eventId] : [])) : [];
    const heading = element('div', 'pane-heading'); heading.append(element('strong', '', aggregate ? `${aggregate.kind === 'declaration' ? 'Declaration' : 'Tactic'} breakdown` : node ? 'Operation breakdown' : 'Inside this file'));
    if (node || aggregate) heading.append(button('All operations', 'text-button', () => goFile(state.file)));
    panel.append(heading);
    const body = element('div', 'detail-body'); panel.append(body);
    if (aggregate) {
      body.append(element('div', 'eyebrow', `${aggregate.kind.toUpperCase()} · RECORDED INTERVAL UNION`), element('h2', 'operation-title', aggregate.name));
      const metrics = element('div', 'operation-metrics'); metrics.append(stat(duration(aggregate.durationMs), 'Recorded time (union)'), stat(String(aggregateChildren.length), 'Contributing operations')); body.append(metrics);
      body.append(element('p', 'muted', aggregate.eventIds ? 'This total combines the elapsed intervals of all operations recorded for this source group. Overlapping intervals are counted once. Choose an operation below to see its nested calls.' : 'This older index contains only a representative operation. Its duration can differ from the aggregate above; capture again to retain every contributing operation.'));
      if (aggregate.sharedWith?.length > 1) body.append(element('p', 'muted', `This recorded interval is shared by ${aggregate.sharedWith.join(', ')}. Do not add these declaration totals together.`));
      if (aggregate.line) body.append(button(`${basename(state.profile.sourceFile)}:${aggregate.line} ↗`, 'source-link', () => { state.sourceFile = state.profile.sourceFile; state.sourceContext = null; renderSource(); }));
    } else if (node) {
      const parents = []; let parent = state.nodes.get(node.parentId), depth = 0;
      while (parent && depth++ < state.profile.nodes.length) { parents.unshift(parent); parent = state.nodes.get(parent.parentId); }
      if (parents.length) {
        const crumbs = element('div', 'operation-parents');
        for (const ancestor of parents.slice(-4)) crumbs.append(button(ancestor.category, 'parent-link', () => selectNode(ancestor.id)), element('span', '', '›'));
        body.append(crumbs);
      }
      body.append(element('div', 'eyebrow', node.category), element('h2', 'operation-title', displayLabel(node)));
      const metrics = element('div', 'operation-metrics'); metrics.append(stat(duration(node.durationMs), 'Inclusive time'), stat(duration(node.selfMs), 'Self / unrecorded children')); body.append(metrics);
      if (node.source) {
        const sourceButton = button(`${basename(node.source.file)}:${node.source.start.line + 1} ↗`, 'source-link', () => { state.sourceFile = node.source.file; state.sourceContext = null; renderSource(); });
        body.append(sourceButton, element('span', 'mapping-label', node.sourceKind === 'exact' ? 'Exact syntax' : 'Enclosing syntax'));
      }
      const disclosure = element('details', 'expression'); disclosure.open = true;
      disclosure.append(element('summary', '', 'Expression / trace detail'), element('pre', '', node.detail || node.label)); body.append(disclosure);
    } else {
      body.append(element('h2', '', 'Start with a source statement'), element('p', 'muted', 'Click a timing bar beside the code, or follow a recorded operation below. Bars stay attached to the original syntax, including macro expansions.'));
      const hot = sourceLineTimings(state.profile.nodes, state.profile.sourceFile).sort((a, b) => b.durationMs - a.durationMs).slice(0, 8);
      const list = element('div', 'hot-statements'), lines = state.profile.sourceText.split(/\r?\n/);
      for (const row of hot) { const control = button('', 'hot-statement', () => selectNode(row.nodeId)); control.append(element('span', '', `${row.line + 1}  ${lines[row.line].trim()}`), element('strong', '', duration(row.durationMs))); list.append(control); }
      body.append(list);
    }
    const children = aggregate ? aggregateChildren : state.children.get(node?.id ?? null) || [];
    const section = element('section', 'operations-section'); section.append(element('h3', '', `${aggregate ? 'Contributing operations' : node ? 'Nested operations' : 'Recorded roots'} · ${children.length}`));
    const denominator = aggregate?.durationMs || node?.durationMs || children.reduce((max, child) => Math.max(max, child.durationMs), .001);
    const maxChildren = 150;
    for (const child of children.slice(0, maxChildren)) {
      const control = button('', 'operation-row', () => selectNode(child.id));
      const title = element('span', 'operation-name', displayLabel(child)); title.title = child.label;
      control.append(title, element('strong', 'operation-time', duration(child.durationMs)), progress(percent(child.durationMs, denominator)), element('small', '', `${duration(child.selfMs)} self`)); section.append(control);
    }
    if (!children.length) section.append(element('p', 'muted', 'No child operations were retained at this recording’s threshold.'));
    if (children.length > maxChildren) section.append(element('p', 'muted', `Showing the ${maxChildren} most expensive children of ${children.length}.`));
    body.append(section);
    if (!aggregate && node?.symbols?.length) {
      const refs = element('section', 'definitions-section'); refs.append(element('h3', '', 'Definitions'), element('p', 'muted', 'References are navigation links. An unfolding records a definition visited within this call, not its independent per-line cost.'));
      for (const symbol of node.symbols) {
        const row = element('div', 'definition-row');
        const control = button(symbol.name, 'definition-link', () => {
          if (symbol.sourceStale || !symbol.file || !symbol.range) return;
          state.sourceFile = symbol.file; state.sourceContext = { symbol, node }; renderSource();
        });
        control.disabled = Boolean(symbol.sourceStale || !symbol.file || !symbol.range);
        if (symbol.sourceStale) control.title = 'Rebuild imports and capture again; this recorded source location could not be verified.';
        row.append(control, element('span', `pill ${symbol.kind === 'unfold' ? 'purple' : ''}`, symbol.sourceStale ? 'Rebuild imports' : symbol.kind === 'unfold' ? 'Unfolded in this call' : 'Reference'));
        refs.append(row);
      }
      body.append(refs);
    }
  }
  function renderFile() {
    const file = state.file, profile = state.profile, parent = file.path.split('/').slice(0, -1).join('/');
    $('page-title').textContent = basename(file.path); $('page-subtitle').textContent = file.path;
    const actions = $('header-actions'); actions.replaceChildren();
    if (!published && file.openInVSCode?.startsWith('vscode://local-lean-tools.lean-source-profiler/open?')) actions.append(link('Open in VS Code ↗', file.openInVSCode, 'primary-button'));
    $('stats').replaceChildren(stat(duration(profile.elapsedMs), 'Lean processing'), stat(profile.captureWallMs === undefined ? '—' : duration(profile.captureWallMs), 'Capture total', 'Including trace export'), stat(profile.nodes.length.toLocaleString(), 'Recorded operations', `Lean ${profile.leanVersion}`));
    setNotice('You are viewing the source saved with this recording. Timings are inclusive; the same work can appear in several nested bars.');
    breadcrumbs(parent, file); renderSidebar();
    const split = element('div', 'file-layout'), source = element('section', 'source-panel'), detail = element('section', 'detail-panel'); source.id = 'source-panel'; detail.id = 'detail-panel'; split.append(source, detail); $('content').replaceChildren(split);
    renderSource(); renderDetail();
  }
  function renderFailedFile(file) {
    $('page-title').textContent = basename(file.path); $('page-subtitle').textContent = file.path; $('header-actions').replaceChildren(element('span', 'status status-partial', 'Capture failed')); $('stats').replaceChildren();
    setNotice('This file has no measured profile. Its time is excluded from all totals.', true);
    breadcrumbs(file.path.split('/').slice(0, -1).join('/'), file); renderSidebar();
    const error = element('div', 'error-panel');
    error.append(element('h2', '', 'Lean could not capture this file'), element('pre', '', file.error || 'No diagnostic was recorded.'), button('Back to folder', 'secondary-button', () => goFolder(file.path.split('/').slice(0, -1).join('/'))));
    $('content').replaceChildren(error);
  }
  async function route() {
    if (!state.session) return;
    const request = ++state.request, params = new URLSearchParams(location.hash.slice(1)), id = params.get('file');
    if (!id) {
      state.file = null; state.profile = null; state.selected = null; state.aggregate = null; state.sourceContext = null;
      state.folder = params.get('folder') || ''; state.limit = 150;
      await renderFolder(); return;
    }
    const file = state.session.files.find(entry => entry.id === id);
    if (!file) { showError(new Error('This file is not part of the recording.')); return; }
    state.file = file; state.folder = file.path.split('/').slice(0, -1).join('/');
    if (file.status !== 'ok') { renderFailedFile(file); return; }
    const sameFile = state.profile && canonical(state.profile.sourceFile) === canonical(file.sourceFile);
    if (!sameFile) $('content').replaceChildren(element('div', 'loading', `Opening ${basename(file.path)}…`));
    try {
      let profile = sameFile ? state.profile : cache.get(id);
      if (!profile) { profile = await api(`/api/file?id=${encodeURIComponent(id)}`); cache.set(id, profile); if (cache.size > 2) cache.delete(cache.keys().next().value); }
      if (request !== state.request) return;
      if (!sameFile) {
        state.profile = profile; state.nodes = new Map(profile.nodes.map(node => [node.id, node])); state.children = new Map();
        for (const node of profile.nodes) { const children = state.children.get(node.parentId) || []; children.push(node); state.children.set(node.parentId, children); }
        for (const children of state.children.values()) children.sort((a, b) => b.durationMs - a.durationMs);
      }
      state.aggregate = null;
      if (['declaration', 'tactic'].includes(params.get('aggregate'))) {
        state.index ??= await api('/api/index');
        if (request !== state.request) return;
        state.aggregate = state.index.find(row => row.kind === params.get('aggregate') && row.path === file.path && row.name === params.get('name') && String(row.line || '') === (params.get('line') || '')) || null;
        if (!state.aggregate) toast('That aggregate entry is not present in this recording’s index. Showing the recorded operation instead.');
      }
      state.selected = state.aggregate ? null : state.nodes.get(params.get('event')) || null;
      state.sourceFile = state.selected?.source?.file && snapshot(state.selected.source.file) !== undefined ? state.selected.source.file : profile.sourceFile;
      state.sourceContext = null; renderFile();
    } catch (error) { if (request === state.request) showError(error); }
  }
  async function main() {
    try {
      state.session = await api('/api/session');
      document.title = `${basename(state.session.projectRoot)} · Lean Source Profiler`;
      $('recording-name').textContent = basename(state.session.projectRoot);
      $('recording-name').title = state.session.projectRoot;
      if (published) {
        const info = $('publication-info'), metadata = state.session.publication;
        info.hidden = false;
        info.append(element('span', '', metadata?.description || 'Public example recording. Only the listed files were profiled.'));
        for (const [label, address] of [['Source and provenance ↗', metadata?.sourceUrl], ['License ↗', metadata?.licenseUrl]]) {
          if (typeof address !== 'string') continue;
          try { if (new URL(address).protocol === 'https:') info.append(link(label, address, 'text-button')); } catch { /* Ignore malformed metadata links. */ }
        }
        info.append(link('Query data (JSONL)', './data/index.jsonl', 'text-button'));
      }
      window.addEventListener('hashchange', () => { void route().catch(showError); });
      await route();
    } catch (error) { showError(error); }
  }
  void main();
})();
