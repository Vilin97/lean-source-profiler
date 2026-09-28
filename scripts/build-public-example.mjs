#!/usr/bin/env node
// Explicit publication step: validate and sanitize a recording before making a static site.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { readSession, readSessionProfile, readIndex } = require('../out/collection.js');
const { normalizeProfile } = require('../out/model.js');
const { renderViewerHtml } = require('../out/viewer.js');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicPackages = new Set(['mathlib', 'batteries', 'aesop', 'Qq', 'proofwidgets', 'importGraph', 'LeanSearchClient', 'plausible', 'Cli']);
const digest = text => createHash('sha256').update(text).digest('hex');
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const posix = file => file.split(path.sep).join('/');
const copyDefined = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));

function publicationMetadata(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Publication provenance must be an object.');
  const result = {};
  for (const key of ['description', 'sourceUrl', 'licenseUrl']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].includes('\0')) throw new Error(`Invalid publication ${key}.`);
    if (key.endsWith('Url')) {
      let url;
      try { url = new URL(input[key]); } catch { throw new Error(`Invalid publication ${key}.`); }
      if (url.protocol !== 'https:' || url.username || url.password || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`Publication ${key} must be a public HTTPS URL without credentials.`);
    }
    result[key] = input[key];
  }
  return result;
}

/** Build an API-free, relocatable static viewer. Never writes to an existing output directory. */
export async function buildPublicExample({ recording, output, title = 'LeanPool', provenance } = {}) {
  if (typeof recording !== 'string' || typeof output !== 'string') throw new Error('A recording and new output directory are required.');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(title)) throw new Error('Title must be a short, filesystem-safe project name.');
  const session = await readSession(recording);
  if (!session.files.some(file => file.status === 'ok')) throw new Error('The recording has no completed successful files to publish.');
  const publication = publicationMetadata(typeof provenance === 'string' ? JSON.parse(await fs.readFile(provenance, 'utf8')) : provenance);
  const capturedProfiles = new Map();
  const declarations = new Map();
  for (const file of session.files) if (file.status === 'ok') {
    const profile = await readSessionProfile(session, file.id);
    capturedProfiles.set(file.id, profile);
    for (const declaration of profile.declarations ?? []) {
      if (declaration.generated || declaration.source.file !== profile.sourceFile) continue;
      const key = JSON.stringify([declaration.source.file, declaration.name]);
      const candidates = declarations.get(key) ?? [];
      candidates.push({ source: declaration.source, sourceText: profile.sourceText });
      declarations.set(key, candidates);
    }
  }
  let enrichedReferences = 0;
  const enrichmentPairs = new Map();
  for (const profile of capturedProfiles.values()) {
    for (const node of profile.nodes) for (const symbol of node.symbols ?? []) {
      if (symbol.range || symbol.sourceStale || !symbol.file || symbol.file === profile.sourceFile) continue;
      const candidates = declarations.get(JSON.stringify([symbol.file, symbol.name]));
      if (candidates?.length !== 1 || profile.sourceTexts?.[symbol.file] !== candidates[0].sourceText) continue;
      // The referenced name and file are semantic metadata, and the imported bytes must agree.
      // This adds a destination, never attributes the caller's timing to the definition.
      const { start, end } = candidates[0].source;
      symbol.range = { start, end };
      enrichedReferences++;
      const key = JSON.stringify([profile.sourceFile, symbol.file]);
      enrichmentPairs.set(key, (enrichmentPairs.get(key) ?? 0) + 1);
    }
  }
  const virtualRoot = `/${title}`;
  const mapped = new Map(), reverse = new Map(), inventory = new Map();
  function mapFile(input) {
    const file = path.normalize(input);
    if (mapped.has(file)) return mapped.get(file);
    let virtual, kind, packageName;
    if (within(session.projectRoot, file)) {
      const relative = posix(path.relative(session.projectRoot, file));
      virtual = relative ? `${virtualRoot}/${relative}` : virtualRoot;
      const dependency = relative.match(/^\.lake\/packages\/([^/]+)\//);
      packageName = dependency?.[1];
      kind = packageName ? 'package' : 'project';
    } else {
      const sharedPackage = posix(file).match(/\/\.lake\/packages\/([^/]+)\/(.+)$/);
      const toolchain = posix(file).match(/\/\.elan\/toolchains\/[^/]+\/src\/lean\/(.+)$/);
      if (sharedPackage) { packageName = sharedPackage[1]; virtual = `${virtualRoot}/.lake/packages/${packageName}/${sharedPackage[2]}`; kind = 'package'; }
      else if (toolchain) { virtual = `/Lean-toolchain/${toolchain[1]}`; kind = 'toolchain'; }
      else { virtual = `/External/${path.basename(file)}`; kind = 'external'; }
    }
    if (reverse.has(virtual) && reverse.get(virtual) !== file) {
      if (kind !== 'external') throw new Error('Two different input sources map to the same public source path.');
      virtual = `/External/${digest(file).slice(0, 16)}-${path.basename(file)}`;
      if (reverse.has(virtual)) throw new Error('Public source path collision.');
    }
    reverse.set(virtual, file);
    const result = { path: virtual, kind, ...(packageName ? { package: packageName } : {}) };
    mapped.set(file, result);
    return result;
  }
  function mapRange(source) { return { file: mapFile(source.file).path, start: source.start, end: source.end }; }
  function publicProfile(profile) {
    const referenced = new Set([profile.sourceFile]);
    for (const node of profile.nodes) {
      if (node.source) referenced.add(node.source.file);
      for (const symbol of node.symbols ?? []) if (symbol.file && symbol.range && !symbol.sourceStale) referenced.add(symbol.file);
    }
    for (const declaration of profile.declarations ?? []) referenced.add(declaration.source.file);
    const sourceTexts = Object.create(null);
    for (const file of [...referenced].sort()) {
      const text = file === profile.sourceFile ? profile.sourceText : profile.sourceTexts?.[file];
      if (text === undefined) continue;
      const mapping = mapFile(file);
      // Paths alone cannot establish that arbitrary files outside the project are publishable.
      if (mapping.kind === 'external') continue;
      if (mapping.kind === 'package' && !publicPackages.has(mapping.package)) throw new Error(`Review the public license/provenance of dependency ${mapping.package} before publishing its source.`);
      if (!file.endsWith('.lean')) throw new Error('Only Lean source snapshots may be published.');
      sourceTexts[mapping.path] = text;
      const entry = { ...mapping, sha256: digest(text), bytes: Buffer.byteLength(text) };
      const previous = inventory.get(mapping.path);
      if (previous && previous.sha256 !== entry.sha256) throw new Error('One source path has inconsistent snapshots across the recording.');
      inventory.set(mapping.path, entry);
    }
    if (sourceTexts[mapFile(profile.sourceFile).path] === undefined) throw new Error('The primary source must be inside the public project.');
    const nodes = profile.nodes.map(node => ({
      ...copyDefined(node, ['id', 'parentId', 'category', 'label', 'detail', 'startMs', 'durationMs', 'selfMs', 'sourceKind', 'thread']),
      ...(node.source ? { source: mapRange(node.source) } : {}),
      symbols: (node.symbols ?? []).map(symbol => {
        const result = copyDefined(symbol, ['name', 'kind', 'sourceStale']);
        // Omitted snapshots have no clickable source destination; names remain useful context.
        if (symbol.file && sourceTexts[mapFile(symbol.file).path] !== undefined) {
          result.file = mapFile(symbol.file).path;
          if (symbol.range && !symbol.sourceStale) result.range = symbol.range;
        }
        return result;
      }),
    }));
    const result = {
      ...copyDefined(profile, ['schemaVersion', 'sourceText', 'leanVersion', 'elapsedMs', 'startedAt', 'captureWallMs', 'thresholdMs', 'captureMethod']),
      sourceFile: mapFile(profile.sourceFile).path, projectRoot: virtualRoot, sourceTexts, nodes,
      ...(profile.declarations ? { declarations: profile.declarations.map(declaration => ({
        ...copyDefined(declaration, ['name', 'kind', 'generated']), source: mapRange(declaration.source),
      })) } : {}),
    };
    // Validate the rewritten model, without adopting normalization's diagnostics field.
    normalizeProfile(result);
    return result;
  }
  const profiles = new Map();
  const files = [];
  for (const [index, file] of session.files.entries()) {
    const id = String(index);
    const expected = path.resolve(session.projectRoot, ...file.path.split('/'));
    if (!within(session.projectRoot, expected) || path.normalize(file.sourceFile) !== expected) throw new Error('Session source paths do not match their project-relative paths.');
    const entry = {
      ...copyDefined(file, ['path', 'status', 'elapsedMs', 'captureWallMs', 'eventCount', 'declarationCount']),
      id, sourceFile: mapFile(file.sourceFile).path,
    };
    if (file.status === 'ok') {
      profiles.set(id, publicProfile(capturedProfiles.get(file.id)));
      entry.profile = `files/${id}.json.gz`;
    } else entry.error = 'Capture failed; local diagnostics are omitted from this public recording.';
    files.push(entry);
  }
  const summary = {
    ...copyDefined(session, ['schemaVersion', 'kind', 'startedAt', 'completedAt', 'status', 'wallMs', 'plannedFileCount', 'singleFile', 'leanVersions']),
    projectRoot: virtualRoot, target: mapFile(session.target).path, sessionPath: '/recording/session.json',
    excluded: [], files, ...(publication ? { publication } : {}),
  };
  // Indexes may contain arbitrary unknown metadata; copy only the validated public schema.
  const index = (await readIndex(session)).map(row => copyDefined(row, ['kind', 'name', 'path', 'durationMs', 'selfMs', 'line', 'endLine', 'eventId', 'eventIds', 'declaration', 'captureWallMs', 'attribution', 'sharedWith']));
  const sourceInventory = [...inventory.values()].sort((a, b) => a.path.localeCompare(b.path));
  const navigationEnrichment = {
    method: 'Exact semantic (source file, declaration name) lookup across successfully captured profiles.',
    conditions: ['Exactly one non-generated declaration in the target profile.', 'Caller imported snapshot equals target sourceText byte for byte.', 'Original symbol has no range and is not marked stale.'],
    enrichedReferences,
    pairs: [...enrichmentPairs].map(([key, references]) => {
      const [fromFile, toFile] = JSON.parse(key);
      return { fromFile: mapFile(fromFile).path, toFile: mapFile(toFile).path, references };
    }).sort((a, b) => a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile)),
    note: 'Enrichment adds declaration navigation only. All events, source ranges and timings are unchanged; caller costs are never assigned to an imported definition.',
  };
  const artifacts = new Map([
    ['data/session.json', JSON.stringify(summary)],
    ['data/index.json', JSON.stringify(index)],
    ['data/index.jsonl', index.map(row => JSON.stringify(row)).join('\n') + (index.length ? '\n' : '')],
    ['data/source-inventory.json', JSON.stringify(sourceInventory, null, 2) + '\n'],
    ['data/navigation-provenance.json', JSON.stringify(navigationEnrichment, null, 2) + '\n'],
    ...[...profiles].map(([id, profile]) => [`data/files/${id}.json.gz`, JSON.stringify(profile)]),
  ]);
  for (const [file, text] of artifacts) {
    if (/\/(?:Users|home)\/|\/(?:private\/)?var\/folders\/|[A-Za-z]:\\\\(?:Users|Documents and Settings)\\\\|(?:vscode|file):\/\//i.test(text) || text.includes(session.projectRoot + '/')) {
      // Never quote the matched value: it may itself be private information.
      throw new Error(`Public export privacy check failed in ${file}; review the recording for local paths. Source text is never silently rewritten.`);
    }
  }
  const destination = path.resolve(output);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.mkdir(destination); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Public output already exists; choose a new directory.'); throw error; }
  try {
    await fs.mkdir(path.join(destination, 'data', 'files'), { recursive: true });
    for (const [file, text] of artifacts) await fs.writeFile(path.join(destination, file), file.endsWith('.gz') ? gzipSync(text, { level: 9 }) : text);
    await fs.writeFile(path.join(destination, 'index.html'), renderViewerHtml({ published: true }));
    for (const asset of ['viewer.js', 'viewer.css']) await fs.copyFile(path.join(repository, 'media', asset), path.join(destination, asset));
  } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
  return { output: destination, session: summary, sources: sourceInventory, files: profiles.size, navigationEnrichment };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  options.recording = args.shift();
  while (args.length) {
    const flag = args.shift();
    const key = { '--output': 'output', '--title': 'title', '--provenance': 'provenance' }[flag];
    if (!key || !args.length || options[key] !== undefined) throw new Error('Usage: node scripts/build-public-example.mjs RECORDING --output NEW_DIR [--title LeanPool] [--provenance JSON]');
    options[key] = args.shift();
  }
  const result = await buildPublicExample(options);
  process.stdout.write(JSON.stringify({ output: result.output, files: result.files, sourceSnapshots: result.sources.length }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
