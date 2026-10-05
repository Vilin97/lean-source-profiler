import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { runProcess } from './capture';

export interface NativeBackend {
  executable: string;
  driverSha256: string;
  clockSha256: string;
  compilerGitHash: string;
  env: NodeJS.ProcessEnv;
  leanExecutable: string;
  binaryIdentity?: string;
}
interface BuildInput {
  project: string; lake: string; source: Buffer; clockSource: Buffer;
  signal?: AbortSignal; onLog?: (text: string) => void;
}
interface Toolchain {
  env: NodeJS.ProcessEnv; prefix: string; leanExecutable: string; compilerGitHash: string;
}
interface BuildIdentity { driverSha256: string; clockSha256: string; compilerGitHash: string; prefix: string }
const pending = new Map<string, Promise<NativeBackend>>();
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function toolchain(input: BuildInput): Promise<Toolchain> {
  const { project, lake, signal, onLog } = input;
  const env = { ...process.env };
  for (const line of (await runProcess(lake, ['env'], project, signal, onLog, undefined, true)).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
    else if (line.trim()) throw new Error('Could not read the Lake environment.');
  }
  const prefix = env.LEAN_SYSROOT ??
    (await runProcess(lake, ['env', 'lean', '--print-prefix'], project, signal, onLog, undefined, true)).trim();
  const leanExecutable = path.join(prefix, 'bin', process.platform === 'win32' ? 'lean.exe' : 'lean');
  const compilerGitHash = env.LEAN_SYSROOT
    ? (await runProcess(leanExecutable, ['--githash'], project, signal, onLog, env, true)).trim()
    : (await runProcess(lake, ['env', 'lean', '--githash'], project, signal, onLog, undefined, true)).trim();
  env.LEAN_SOURCE_PROFILER_CLOCK = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)
    ? 'Linux CLOCK_MONOTONIC_RAW (Lean builtin trace calibration)' : 'Lean IO.monoNanosNow';
  env.LEAN_SOURCE_PROFILER_NATIVE = '1';
  return { env, prefix, leanExecutable, compilerGitHash };
}

async function verified(cache: string, executable: string, expected: BuildIdentity): Promise<boolean> {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(cache, 'build.json'), 'utf8'));
    return Object.entries(expected).every(([key, value]) => receipt[key] === value) &&
      hash(await fs.readFile(executable)) === receipt.binarySha256;
  } catch { return false; } // Missing/incomplete/corrupt builds are never executed.
}

async function directoryIdentity(directory: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(directory);
    return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function quarantine(cache: string, observed?: string): Promise<void> {
  // A miss must not move a build that another process has just successfully published.
  if (!observed || await directoryIdentity(cache) !== observed) return;
  try { await fs.rename(cache, cache + '-invalid-' + Date.now() + '-' + process.pid); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function build(input: BuildInput, staging: string, binary: string, prefix: string): Promise<void> {
  const { project, lake, source, clockSource, signal, onLog } = input;
  onLog?.('Building the native profiling driver for this Lean toolchain (cached for later captures)…\n');
  const leanFile = path.join(staging, 'SourceProfiler.lean'), cFile = path.join(staging, 'profiler.c');
  const clockFile = path.join(staging, 'Clock.c');
  await fs.writeFile(leanFile, source);
  await fs.writeFile(clockFile, clockSource);
  await runProcess(lake, ['env', 'lean', '-R', staging, '-c', cFile, leanFile], project, signal, onLog);
  // Imported metaprograms need externs not directly referenced by the driver.
  const library = path.join(prefix, 'lib', 'lean');
  const exports = process.platform === 'win32'
    ? ['-Wl,--whole-archive', '-lleanmanifest', '-Wl,--no-whole-archive'] : ['-rdynamic'];
  await runProcess(lake, ['env', 'leanc', '-O3', '-o', binary, cFile, clockFile, ...exports,
    '-L', library, '-Wl,-rpath,' + library, '-lleanshared'], project, signal, onLog);
}

async function publish(staging: string, cache: string, executable: string, identity: BuildIdentity): Promise<void> {
  try { await fs.rename(staging, cache); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    if (!await verified(cache, executable, identity)) throw new Error('Invalid native profiler cache.');
  }
}

async function compile(input: BuildInput): Promise<NativeBackend> {
  const { env, prefix, leanExecutable, compilerGitHash } = await toolchain(input);
  const identity = { driverSha256: hash(input.source), clockSha256: hash(input.clockSource), compilerGitHash, prefix };
  const key = hash(JSON.stringify([identity.driverSha256, identity.clockSha256, compilerGitHash,
    prefix, process.platform, process.arch, '-O3', 'interpreter-shared-v2']));
  const cache = path.join(os.homedir(), '.cache', 'lean-source-profiler', key);
  const executable = path.join(cache, process.platform === 'win32' ? 'profiler.exe' : 'profiler');
  const backend = { executable, ...identity, env, leanExecutable };
  const observed = await directoryIdentity(cache);
  if (await verified(cache, executable, identity)) return backend;
  await quarantine(cache, observed);
  await fs.mkdir(path.dirname(cache), { recursive: true });
  const staging = await fs.mkdtemp(cache + '-build-');
  try {
    const binary = path.join(staging, path.basename(executable));
    await build(input, staging, binary, prefix);
    await fs.writeFile(path.join(staging, 'build.json'), JSON.stringify({
      ...identity, binarySha256: hash(await fs.readFile(binary)),
    }) + '\n');
    await publish(staging, cache, executable, identity);
    return backend;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function configurationHashes(project: string): Promise<string[]> {
  const result: string[] = [];
  for (const file of ['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json']) {
    try { result.push(hash(await fs.readFile(path.join(project, file)))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}

async function binaryIdentity(executable: string): Promise<string> {
  const stat = await fs.stat(executable);
  return JSON.stringify([stat.ino, stat.size, stat.mtimeMs]);
}

export async function prepareBackend(project: string, lake: string, extension: string,
  signal?: AbortSignal, onLog?: (text: string) => void): Promise<NativeBackend> {
  const source = await fs.readFile(path.join(extension, 'lean', 'SourceProfiler.lean'));
  const clockSource = await fs.readFile(path.join(extension, 'lean', 'Clock.c'));
  const key = JSON.stringify([project, lake, await configurationHashes(project), hash(source), hash(clockSource)]);
  let result = pending.get(key);
  if (result) {
    const backend = await result;
    try {
      if (backend.binaryIdentity === await binaryIdentity(backend.executable)) return backend;
    } catch { /* Deleted/replaced executables must be revalidated and rebuilt. */ }
    pending.delete(key); result = undefined;
  }
  if (!result) {
    result = compile({ project, lake, source, clockSource, signal, onLog }).then(async backend => {
      backend.binaryIdentity = await binaryIdentity(backend.executable);
      return backend;
    });
    pending.set(key, result);
    result.catch(() => { if (pending.get(key) === result) pending.delete(key); });
  }
  return result;
}
