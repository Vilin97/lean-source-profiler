import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const vsixOnly = process.argv.slice(2).includes('--vsix-only');
if (process.argv.slice(2).some(arg => arg !== '--vsix-only')) throw new Error('Unknown release argument.');
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Invalid package version.');

// VSCE explicitly supports SOURCE_DATE_EPOCH. A fixed default also makes ZIPs
// reproducible from source archives, where a Git commit timestamp is unavailable.
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 946684800);
if (!Number.isSafeInteger(epoch) || epoch < 315532800 || epoch > 4354819199) {
  throw new Error('SOURCE_DATE_EPOCH must be an integer timestamp within ZIP range 1980–2107.');
}
// ZIP DOS timestamps are interpreted in the process timezone by zip writers.
process.env.TZ = 'UTC';
const env = { ...process.env, SOURCE_DATE_EPOCH: String(epoch), TZ: 'UTC' };
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env, shell: false, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`${path.basename(command)} ${args.join(' ')} exited ${result.status}`);
  }
  return result.stdout;
}
function npm(args, options) {
  const npmCli = process.env.npm_execpath;
  return npmCli?.endsWith('.js')
    ? run(process.execPath, [npmCli, ...args], options)
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

const stableVsix = path.join(dist, 'lean-source-profiler.vsix');
const versionedVsix = path.join(dist, `lean-source-profiler-${manifest.version}.vsix`);
run(process.execPath, [path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'),
  'package', '--no-dependencies', '--githubBranch', 'main', '--out', versionedVsix]);
// VSCE's vscode:prepublish invokes the normal build once, before collecting files.
await copyFile(versionedVsix, stableVsix);
if (vsixOnly) {
  console.log(`Packaged ${path.relative(root, stableVsix)}`);
} else {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lean-source-profiler-release-'));
  try {
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { capture: true }));
    if (packed.length !== 1 || !packed[0].filename) throw new Error('npm pack returned an unexpected artifact.');
    for (const entry of packed[0].files ?? []) {
      if (/(^|\/)(node_modules|test|results|\.leanprofiles|\.lake|dist)(\/|$)/.test(entry.path)) {
        throw new Error(`Unexpected private/development file in CLI tarball: ${entry.path}`);
      }
    }
    const tarball = path.join(dist, 'lean-source-profiler-cli.tgz');
    await copyFile(path.join(temp, packed[0].filename), tarball);

    const instructions = `Lean Source Profiler ${manifest.version}

1. Extract this ZIP.
2. Double-click "Install Lean Source Profiler.command" next to the VSIX.
3. In VS Code, open a Lean project with built imports.
4. Run "Lean Source Profiler: Profile Current File", "Profile Folder", or "Profile Project".

Manual extension installation:
  code --install-extension lean-source-profiler.vsix --force
Or use VS Code > Extensions > ... > Install from VSIX.

Optional command-line installation (requires Node.js 20 or newer):
  npm install -g https://github.com/Vilin97/lean-source-profiler/releases/latest/download/lean-source-profiler-cli.tgz
  lean-profile --help

The editor extension uses VS Code's Node runtime; a separate Node installation is
only needed for the optional command-line tool. Profiling requires Lake/elan,
built imports, and the tested Lean 4.34.0-rc2 toolchain. Viewing recordings does
not require Lean.

Documentation: https://github.com/Vilin97/lean-source-profiler
Issues: https://github.com/Vilin97/lean-source-profiler/issues
`;
    const installer = await readFile(path.join(root, 'scripts', 'install.command'));
    const installerOutput = path.join(dist, 'Install Lean Source Profiler.command');
    await writeFile(installerOutput, installer);
    await chmod(installerOutput, 0o755);
    await writeFile(path.join(dist, 'START-HERE.txt'), instructions);
    const zip = new yazl.ZipFile();
    const zipPath = path.join(dist, 'lean-source-profiler-macos.zip');
    const zipEntries = [
      { name: 'Install Lean Source Profiler.command', contents: installer, mode: 0o100755 },
      { name: 'START-HERE.txt', contents: Buffer.from(instructions), mode: 0o100644 },
      { name: 'lean-source-profiler.vsix', contents: await readFile(stableVsix), mode: 0o100644 },
    ];
    for (const entry of zipEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      zip.addBuffer(entry.contents, `Lean Source Profiler/${entry.name}`, { mtime: new Date(epoch * 1000), mode: entry.mode });
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(zipPath));
    await copyFile(zipPath, path.join(dist, `lean-source-profiler-${manifest.version}-macos.zip`));

    const assets = ['lean-source-profiler.vsix', 'lean-source-profiler-macos.zip', 'lean-source-profiler-cli.tgz'];
    const checksums = await Promise.all(assets.map(async name =>
      `${createHash('sha256').update(await readFile(path.join(dist, name))).digest('hex')}  ${name}`));
    await writeFile(path.join(dist, 'SHA256SUMS'), checksums.join('\n') + '\n');
    console.log(`Release ${manifest.version}:\n${assets.map(name => `  dist/${name}`).join('\n')}\n  dist/SHA256SUMS`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
