#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { capture, readProfile } = require('../out/capture.js');
const { discoverLeanFiles } = require('../out/collection.js');
const { summarize } = require('./whole-pool-summary.cjs');

const extensionRoot = path.resolve(__dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const fileDigest = async file => digest(await fs.readFile(file));
const now = () => new Date().toISOString();

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}

async function run(command, args, cwd, signal, inherit = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code}`)));
  });
}

function groupName(sourcePath) { return sourcePath.split('/')[1].replace(/\.lean$/, ''); }
function setupPath(repository, entry) { return path.join(repository, '.lake/build/ir', entry.path.replace(/\.lean$/, '.setup.json')); }
function rawPath(output, entry) { return path.join(output, 'raw', entry.id.padStart(6, '0') + '.leanprofile.json'); }
function summaryPath(output, entry) { return path.join(output, 'full/summaries', entry.id + '.json'); }
function receiptPath(output, entry) { return path.join(output, 'receipts', entry.id + '.json'); }

async function inventory(repository, signal) {
  const scope = await discoverLeanFiles(path.join(repository, 'LeanPool'));
  const excluded = (process.env.LEAN_POOL_PROFILE_EXCLUDE || '').split(',').filter(Boolean);
  const projects = new Map();
  let count = 0;
  for (const file of scope.files) {
    const relative = path.relative(repository, file).split(path.sep).join('/'), name = groupName(relative);
    if (excluded.includes(name)) continue;
    const source = await fs.readFile(file);
    const entry = { id: String(count++), path: relative, sha256: digest(source), lines: source.toString('utf8').split(/\r?\n/).length };
    if (!projects.has(name)) projects.set(name, { name, files: [], lines: 0 });
    const project = projects.get(name);
    project.files.push(entry); project.lines += entry.lines;
  }
  if (!count) throw new Error('The source inventory is empty.');
  const commit = await run('git', ['rev-parse', 'HEAD'], repository, signal, false);
  const profilerCommit = await run('git', ['rev-parse', 'HEAD'], extensionRoot, signal, false);
  const configuration = {};
  for (const file of ['lean-toolchain', 'lakefile.toml', 'lake-manifest.json']) {
    try { configuration[file] = await fileDigest(path.join(repository, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { repository, commit, profilerCommit, files: count, projects: [...projects.values()], configuration,
    configurationMode: 'native-lake', captureMode: 'compact', excluded: [...scope.excluded, ...excluded] };
}

async function initialize(repository, output, signal) {
  await run('git', ['diff', '--exit-code', 'HEAD'], repository, signal, false);
  const current = await inventory(repository, signal), file = path.join(output, 'inventory.json');
  try {
    if (!isDeepStrictEqual(await readJson(file), current)) throw new Error('Cannot resume: pinned source inventory, configuration or profiler changed.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await writeJson(file, current); }
  const metadata = path.join(output, 'run.json');
  try { await readJson(metadata); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeJson(metadata, { startedAt: now() }); }
  return current;
}

async function buildProject(repository, output, project, lake, signal) {
  const marker = path.join(output, 'builds', project.name + '.json');
  try {
    const built = await readJson(marker);
    for (const entry of project.files) {
      await fs.access(path.join(repository, '.lake/build/lib/lean', entry.path.replace(/\.lean$/, '.olean')));
      if (built[entry.path] !== await fileDigest(setupPath(repository, entry))) throw new Error('Native module setup changed.');
    }
    return;
  } catch (error) { if (signal.aborted) throw error; }
  for (let index = 0; index < project.files.length; index += 128) {
    const targets = project.files.slice(index, index + 128).map(entry => '+' + entry.path.replace(/\.lean$/, '').replaceAll('/', '.') + ':olean');
    await run(lake, ['build', ...targets], repository, signal);
  }
  const built = {};
  for (const entry of project.files) built[entry.path] = await fileDigest(setupPath(repository, entry));
  await writeJson(marker, built);
}

async function completed(repository, output, entry) {
  try {
    const receipt = await readJson(receiptPath(output, entry));
    return receipt.sourceSha256 === entry.sha256 && receipt.setupSha256 === await fileDigest(setupPath(repository, entry)) &&
      receipt.rawSha256 === await fileDigest(rawPath(output, entry)) && receipt.summarySha256 === await fileDigest(summaryPath(output, entry));
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function captureFile(repository, output, entry, lake, signal) {
  if (await completed(repository, output, entry)) return;
  const source = path.join(repository, entry.path), setup = setupPath(repository, entry);
  const setupBefore = await fileDigest(setup);
  if (await fileDigest(source) !== entry.sha256) throw new Error('Source changed before capture.');
  const profile = await capture({ file: source, extensionRoot, output: rawPath(output, entry), mode: 'compact', thresholdMs: 1, lakePath: lake, signal });
  if (profile.moduleSetup?.mode !== 'lake' || setupBefore !== await fileDigest(setup)) throw new Error('Capture did not retain its native module setup.');
  if (digest(profile.sourceText) !== entry.sha256) throw new Error('Captured source does not match the inventory.');
  await writeJson(summaryPath(output, entry), summarize(profile, entry));
  await writeJson(receiptPath(output, entry), { sourceSha256: entry.sha256, setupSha256: setupBefore,
    rawSha256: await fileDigest(rawPath(output, entry)), summarySha256: await fileDigest(summaryPath(output, entry)) });
}

async function audit(repository, output, expected, signal) {
  const actual = await inventory(repository, signal);
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Final source inventory differs from the pinned inventory.');
  const files = {}, entries = [], versions = new Set();
  for (const project of expected.projects) {
    const builds = await readJson(path.join(output, 'builds', project.name + '.json'));
    for (const entry of project.files) {
      if (signal.aborted) throw new Error('Audit cancelled.');
      if (builds[entry.path] !== await fileDigest(setupPath(repository, entry)) || !await completed(repository, output, entry)) throw new Error(`Missing or changed native build/capture: ${entry.path}`);
      const profile = await readProfile(rawPath(output, entry));
      const summary = await readJson(summaryPath(output, entry));
      if (profile.sourceFile !== path.join(repository, entry.path) || digest(profile.sourceText) !== entry.sha256 ||
        !isDeepStrictEqual(summary, JSON.parse(JSON.stringify(summarize(profile, entry))))) throw new Error(`Recording/summary audit failed: ${entry.path}`);
      const { source, children, ...metadata } = summary;
      files[entry.path] = metadata; entries.push({ id: entry.id, path: entry.path, status: 'ok' }); versions.add(profile.leanVersion);
    }
    console.log(`Audited ${project.name}: ${project.files.length} files`);
  }
  return { files, entries, versions: [...versions] };
}

async function finish(repository, output, expected, signal) {
  const checked = await audit(repository, output, expected, signal), completedAt = now();
  const { startedAt } = await readJson(path.join(output, 'run.json'));
  const session = { schemaVersion: 2, kind: 'lean-source-profile-session', startedAt, completedAt, status: 'complete',
    wallMs: Date.parse(completedAt) - Date.parse(startedAt), plannedFileCount: expected.files, files: checked.entries,
    leanVersions: checked.versions, configurationMode: expected.configurationMode, excluded: expected.excluded };
  await writeJson(path.join(output, 'full/overview.json'), { name: 'LeanPool', commit: expected.commit, profilerCommit: expected.profilerCommit,
    inventory: expected.projects.map(project => ({ name: project.name, files: project.files.length, lines: project.lines })), session, files: checked.files });
  await writeJson(path.join(output, 'final-coverage.json'), { checkedAt: completedAt, result: 'PASS', expected: expected.files,
    filesystemFiles: expected.files, successful: checked.entries.length, failed: 0, missing: [], unexpected: [],
    allSourcesUnchanged: true, allSummariesMatchRecordings: true, allProjectBuildsPassed: true, projectGroups: expected.projects.length,
    sessionCompletedAt: completedAt, commit: expected.commit });
}

async function capturePool(repository, output, lake, signal) {
  const expected = await initialize(repository, output, signal), errors = [];
  let successful = 0;
  const progress = async (stage, current) => writeJson(path.join(output, 'progress.json'), { stage, current,
    successful, failed: errors.length, planned: expected.files, commit: expected.commit, updatedAt: now() });
  for (const project of expected.projects) {
    if (signal.aborted) throw new Error('Capture cancelled.');
    console.log(`Building ${project.name}: ${project.files.length} modules with native Lake settings`);
    await progress('build', project.name);
    try { await buildProject(repository, output, project, lake, signal); }
    catch (error) {
      if (signal.aborted) throw error;
      errors.push({ project: project.name, stage: 'build', error: error.message });
      console.error(`Build failed for ${project.name}: ${error.message}`); continue;
    }
    for (const entry of project.files) {
      if (signal.aborted) throw new Error('Capture cancelled.');
      await progress('capture', entry.path);
      console.log(`[${successful + errors.length + 1}/${expected.files}] ${entry.path}`);
      try { await captureFile(repository, output, entry, lake, signal); successful++; }
      catch (error) {
        if (signal.aborted) throw error;
        errors.push({ path: entry.path, stage: 'capture', error: error.message });
        console.error(`Capture failed for ${entry.path}: ${error.message}`);
      }
    }
  }
  await writeJson(path.join(output, 'errors.json'), errors);
  if (errors.length) { await progress('failed'); throw new Error(`${errors.length} build/capture failures. Successful checkpoints are retained; publication refused.`); }
  await progress('audit'); await finish(repository, output, expected, signal); await progress('complete');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Usage: node scripts/capture-whole-pool.cjs REPOSITORY RECORDING_DIRECTORY');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { process.exitCode = signal === 'SIGINT' ? 130 : 143; controller.abort(); });
  await capturePool(path.resolve(args[0]), path.resolve(args[1]), process.env.LAKE || 'lake', controller.signal);
}

module.exports = { inventory, capturePool, audit, completed };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode ||= 1; });
