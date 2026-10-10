'use strict';
const { buildFileIndex } = require('../out/query.js');

const positionCompare = (a, b) => a.line - b.line || a.character - b.character;
const rangeKey = range => JSON.stringify([range.start, range.end]);
const contains = (outer, inner) => positionCompare(outer.start, inner.start) <= 0 && positionCompare(inner.end, outer.end) <= 0;

function declarationGroups(profile, sourcePath) {
  const groups = new Map();
  for (const declaration of profile.declarations || []) {
    if (declaration.generated || declaration.source.file !== profile.sourceFile) continue;
    const key = rangeKey(declaration.source);
    let group = groups.get(key);
    if (!group) {
      group = { name: '', kind: 'declaration', range: { ...declaration.source, file: sourcePath }, names: [], value: 0, sourceValue: 0, children: [] };
      groups.set(key, group);
    }
    group.names.push(declaration.name);
    group.name = group.names.join(', ');
  }
  const inclusive = new Map(buildFileIndex(profile, sourcePath).filter(row => row.kind === 'declaration').map(row => [row.name, row.durationMs]));
  for (const group of groups.values()) group.inclusiveMs = inclusive.get(group.names[0]);
  return [...groups.values()].sort((a, b) => positionCompare(a.range.start, b.range.start) || positionCompare(a.range.end, b.range.end));
}

function declarationOwner(groups) {
  const maxima = [];
  for (const group of groups) {
    const previous = maxima.at(-1);
    maxima.push(previous && positionCompare(previous, group.range.end) > 0 ? previous : group.range.end);
  }
  return range => {
    let low = 0, high = groups.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positionCompare(groups[middle].range.start, range.start) <= 0) low = middle + 1;
      else high = middle;
    }
    let selected;
    for (let index = low - 1; index >= 0; index--) {
      if (positionCompare(maxima[index], range.end) < 0) break;
      const group = groups[index];
      if (contains(group.range, range) && (!selected || positionCompare(group.range.start, selected.range.start) > 0 ||
        positionCompare(group.range.start, selected.range.start) === 0 && positionCompare(group.range.end, selected.range.end) < 0)) selected = group;
    }
    return selected;
  };
}

function depths(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node])), result = new Map();
  for (const node of nodes) {
    const pending = [];
    let current = node;
    while (current && !result.has(current.id)) { pending.push(current); current = byId.get(current.parentId); }
    let depth = current ? result.get(current.id) + 1 : 0;
    for (const ancestor of pending.reverse()) result.set(ancestor.id, depth++);
  }
  return result;
}

// A heap per source thread keeps large captures from scanning every active scope.
class ScopeHeap {
  constructor() { this.values = []; this.active = new Set(); }
  higher(a, b) { return a.depth > b.depth || a.depth === b.depth && (a.node.startMs > b.node.startMs || a.node.startMs === b.node.startMs && a.order > b.order); }
  add(scope) {
    this.active.add(scope.node.id);
    const values = this.values;
    let index = values.length;
    values.push(scope);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!this.higher(values[index], values[parent])) break;
      [values[index], values[parent]] = [values[parent], values[index]];
      index = parent;
    }
  }
  remove(scope) { this.active.delete(scope.node.id); }
  top() {
    const values = this.values;
    while (values.length && !this.active.has(values[0].node.id)) {
      const last = values.pop();
      if (!values.length) break;
      values[0] = last;
      let index = 0;
      while (true) {
        let child = 2 * index + 1;
        if (child >= values.length) break;
        if (child + 1 < values.length && this.higher(values[child + 1], values[child])) child++;
        if (!this.higher(values[child], values[index])) break;
        [values[index], values[child]] = [values[child], values[index]];
        index = child;
      }
    }
    return values[0];
  }
}

function allocateSourceTime(profile) {
  const depth = depths(profile.nodes), boundaries = [], allocation = new Map();
  profile.nodes.forEach((node, order) => {
    if (node.source?.file !== profile.sourceFile) return;
    const start = Math.max(0, node.startMs), end = Math.min(profile.elapsedMs, node.startMs + node.durationMs);
    if (end <= start) return;
    const scope = { node, order, depth: depth.get(node.id), thread: node.thread || 'main' };
    boundaries.push({ time: start, start: true, scope }, { time: end, start: false, scope });
  });
  boundaries.sort((a, b) => a.time - b.time);
  const threads = new Map();
  let previous = 0;
  for (let index = 0; index < boundaries.length;) {
    const time = boundaries[index].time, active = [...threads.values()].map(heap => heap.top()).filter(Boolean);
    const share = active.length ? (time - previous) / active.length : 0;
    for (const scope of active) allocation.set(scope.node, (allocation.get(scope.node) || 0) + share);
    while (index < boundaries.length && boundaries[index].time === time) {
      const boundary = boundaries[index++], key = boundary.scope.thread;
      let heap = threads.get(key);
      if (!heap) { heap = new ScopeHeap(); threads.set(key, heap); }
      if (boundary.start) heap.add(boundary.scope); else heap.remove(boundary.scope);
      if (!heap.top()) threads.delete(key);
    }
    previous = time;
  }
  return allocation;
}

function summarize(profile, entry) {
  const groups = declarationGroups(profile, entry.path), owner = declarationOwner(groups);
  const other = { name: 'Other source scopes', kind: 'declaration', value: 0, sourceValue: 0, children: [] };
  const lines = profile.sourceText.split(/\r?\n/), anchors = new Map();
  let sourceValue = 0;
  for (const [node, value] of allocateSourceTime(profile)) {
    const group = owner(node.source) || other, line = node.source.start.line + 1;
    let byLine = anchors.get(group);
    if (!byLine) { byLine = new Map(); anchors.set(group, byLine); }
    let anchor = byLine.get(line);
    if (!anchor) {
      anchor = { name: `L${line}  ${(lines[line - 1] || '').trim().slice(0, 120)}`, kind: 'line', line, value: 0, sourceValue: 0, children: [] };
      byLine.set(line, anchor); group.children.push(anchor);
    }
    anchor.value += value; anchor.sourceValue += value;
    group.value += value; group.sourceValue += value; sourceValue += value;
  }
  for (const group of groups) {
    if (!group.value) group.attributionStatus = 'no-separate-timing';
    delete group.names;
  }
  if (other.value) groups.push(other);
  for (const group of groups) group.children.sort((a, b) => a.line - b.line);
  groups.push({ name: 'Imports and unrecorded frontend', kind: 'declaration', value: Math.max(0, profile.elapsedMs - sourceValue), sourceValue: 0, children: [] });
  return { id: entry.id, name: entry.path.split('/').at(-1), kind: 'file', path: entry.path,
    value: profile.elapsedMs, sourceValue, captureWallMs: profile.captureWallMs, eventCount: profile.nodes.length,
    thresholdMs: profile.thresholdMs, leanVersion: profile.leanVersion, captureMode: profile.captureMode,
    sourceClock: profile.sourceClock, configurationMode: profile.moduleSetup?.mode,
    moduleOptions: profile.moduleSetup?.options, exporter: 'weekly-compact-source-allocation-v1',
    exporterDriverSha256: profile.driverSha256, source: profile.sourceText, children: groups };
}

module.exports = { allocateSourceTime, summarize };
