import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { normalizeProfile, Profile } from './model';

export interface CaptureOptions {
  file: string;
  extensionRoot: string;
  output?: string;
  thresholdMs?: number;
  lakePath?: string;
  signal?: AbortSignal;
  onLog?: (text: string) => void;
}
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }

export async function findProjectRoot(file: string): Promise<string> {
  let dir = path.dirname(path.resolve(file));
  let toolchain: string | undefined;
  while (true) {
    if (await exists(path.join(dir, 'lakefile.toml')) || await exists(path.join(dir, 'lakefile.lean'))) return dir;
    if (!toolchain && await exists(path.join(dir, 'lean-toolchain'))) toolchain = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (toolchain) return toolchain;
  throw new Error('No Lean project found. Open a saved .lean file inside a project with a lean-toolchain and built imports.');
}

async function lakeExecutable(configured?: string): Promise<string> {
  if (configured && configured !== 'lake') return configured;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'lake.exe' : 'lake');
    if (await exists(candidate)) return candidate;
  }
  const elan = path.join(os.homedir(), '.elan', 'bin', process.platform === 'win32' ? 'lake.exe' : 'lake');
  if (await exists(elan)) return elan;
  throw new Error('Lake was not found. Install Lean through elan, or set leanSourceProfiler.lakePath.');
}

export async function runProcess(command: string, args: string[], cwd: string, signal?: AbortSignal, onLog?: (s: string) => void): Promise<string> {
  if (signal?.aborted) throw new Error('Profile capture cancelled.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true });
    let tail = '', settled = false, killTimer: NodeJS.Timeout | undefined;
    function kill(sig: NodeJS.Signals) {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already exited */ }
    }
    const abort = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000); killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error); else resolve(tail);
    };
    const log = (chunk: Buffer) => {
      const text = chunk.toString(); tail = (tail + text).slice(-200_000); onLog?.(text);
    };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('error', error => finish(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('close', code => {
      if (signal?.aborted) finish(new Error('Profile capture cancelled.'));
      else if (code !== 0) finish(new Error(`Lean profile capture failed (exit ${code}).\n${tail.slice(-12000)}\nCheck that imports are built with lake build. This release is tested with Lean 4.34.0-rc2.`));
      else finish();
    });
  });
}

export async function readProfile(file: string): Promise<Profile> {
  const stat = await fs.stat(file);
  if (stat.size > 150 * 1024 * 1024) throw new Error('Recording exceeds the 150 MB viewing limit. Capture with a larger internal trace threshold.');
  let data: unknown;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new Error('Could not read profile JSON. Choose a .leanprofile.json recording.'); }
  const profile = normalizeProfile(data);
  profile.profilePath = path.resolve(file);
  return profile;
}

export async function capture(options: CaptureOptions): Promise<Profile> {
  const file = await fs.realpath(path.resolve(options.file));
  if (path.extname(file) !== '.lean') throw new Error('Choose a saved .lean source file to profile.');
  const projectRoot = await findProjectRoot(file);
  const threshold = options.thresholdMs ?? 1;
  if (!Number.isSafeInteger(threshold) || threshold < 0) throw new Error('The threshold must be a nonnegative whole number of milliseconds.');
  const sourceBefore = await fs.readFile(file, 'utf8');
  const lake = await lakeExecutable(options.lakePath);
  const driver = path.join(options.extensionRoot, 'lean', 'SourceProfiler.lean');
  if (!(await exists(driver))) throw new Error(`The bundled Lean capture driver is missing: ${driver}`);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-source-profile-'));
  const raw = path.join(temp, 'capture.json');
  const started = performance.now();
  try {
    options.onLog?.(`Profiling ${file}\nProject: ${projectRoot}\nInternal threshold: ${threshold} ms\n`);
    await runProcess(lake, ['env', 'lean', '--run', driver, file, raw, String(threshold)], projectRoot, options.signal, options.onLog);
    const profile = await readProfile(raw);
    if (profile.sourceFile !== file || profile.sourceText !== sourceBefore || await fs.readFile(file, 'utf8') !== sourceBefore) {
      throw new Error('The source changed during capture. No recording was saved; profile the saved file again.');
    }
    profile.projectRoot = projectRoot;
    profile.captureWallMs = performance.now() - started;
    profile.startedAt = new Date(Date.now() - profile.captureWallMs).toISOString();
    // Snapshots make navigation overlays fail closed after editing an imported definition.
    const sourceFiles = new Set(profile.nodes.flatMap(n => [n.source?.file, ...(n.symbols ?? []).map(s => s.file)]).filter((x): x is string => Boolean(x)));
    let bytes = Buffer.byteLength(sourceBefore);
    profile.sourceTexts = { [file]: sourceBefore };
    for (const sourceFile of sourceFiles) {
      if (sourceFile === file || bytes > 20_000_000) continue;
      try {
        const stat = await fs.stat(sourceFile);
        if (!stat.isFile() || stat.size > 2_000_000) continue;
        const contents = await fs.readFile(sourceFile, 'utf8');
        profile.sourceTexts[sourceFile] = contents; bytes += Buffer.byteLength(contents);
      } catch { /* location can remain navigable if source is temporarily unavailable */ }
    }
    if (options.signal?.aborted) throw new Error('Profile capture cancelled.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const output = path.resolve(options.output ?? path.join(projectRoot, '.leanprofiles', `${path.basename(file, '.lean')}-${stamp}.leanprofile.json`));
    if (output === file) throw new Error('The recording output must not overwrite the Lean source file.');
    profile.profilePath = output;
    const serialized = JSON.stringify(profile);
    if (Buffer.byteLength(serialized) > 150 * 1024 * 1024) throw new Error('Recording and source snapshots exceed the 150 MB viewing limit. Increase leanSourceProfiler.thresholdMs and capture again. No output was replaced.');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const staged = `${output}.${process.pid}.tmp`;
    try { await fs.writeFile(staged, serialized); await fs.rename(staged, output); }
    finally { await fs.rm(staged, { force: true }); }
    return profile;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
