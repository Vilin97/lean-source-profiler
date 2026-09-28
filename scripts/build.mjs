import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
await build({ entryPoints: ['src/extension.ts', 'src/cli.ts', 'src/model.ts', 'src/capture.ts', 'src/collection.ts', 'src/query.ts', 'src/viewer.ts'], outdir: 'out', bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, external: ['vscode'], logLevel: 'info' });
