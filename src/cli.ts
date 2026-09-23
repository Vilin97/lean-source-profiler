#!/usr/bin/env node
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { capture } from './capture';

const help = `Lean Source Profiler

  node out/cli.js profile FILE.lean [--output FILE.leanprofile.json] [--threshold MS] [--lake PATH]
  node out/cli.js open FILE.leanprofile.json

Profile uses the file's Lake project and bundled Lean frontend. Imports must already be built.
Open visualizes an existing recording in VS Code with the extension installed.
Tested toolchain: Lean 4.34.0-rc2. Ctrl-C cancels capture.
`;

async function main() {
  const [command, file, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') { console.log(help); return; }
  if (!file) throw new Error(help);
  if (command === 'open') {
    if (args.length) throw new Error('open accepts one recording path.');
    const uri = `vscode://local-lean-tools.lean-source-profiler/open?file=${encodeURIComponent(path.resolve(file))}`;
    const child = spawn('code', ['--open-url', uri], { shell: false, stdio: 'inherit' });
    await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', c => c === 0 ? resolve() : reject(new Error(`VS Code exited ${c}`))); });
    return;
  }
  if (command !== 'profile') throw new Error(help);
  let output: string | undefined, thresholdMs = 1, lakePath: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error(`Missing value for ${args[i]}`);
    if (args[i] === '--output' || args[i] === '-o') output = value;
    else if (args[i] === '--threshold') thresholdMs = Number(value);
    else if (args[i] === '--lake') lakePath = value;
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const profile = await capture({ file, output, thresholdMs, lakePath, extensionRoot: path.resolve(__dirname, '..'), signal: controller.signal, onLog: s => process.stderr.write(s) });
  console.log(profile.profilePath);
  console.error(`${profile.nodes.length} events; ${profile.elapsedMs.toFixed(1)} ms recorded; ${profile.captureWallMs?.toFixed(1)} ms capture wall time.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
