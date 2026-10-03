// Used by benchmark-capture.py; a single long-lived host excludes Node startup per file.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { prepareBackend, capture, runProcess } = require('../out/capture.js');
const { buildFileIndex } = require('../out/query.js');
const controller=new AbortController();
process.stdin.once('end',()=>controller.abort());
process.once('SIGTERM',()=>{controller.abort();process.stdin.destroy();});
const root = path.resolve(__dirname, '..');
async function run(request) {
  const { project, file, output, mode, setup } = request;
  const start = performance.now();
  const backend = await prepareBackend(project, 'lake', root,controller.signal);
  if (request.driverSha256 && request.driverSha256 !== backend.driverSha256) throw new Error('Driver changed during the benchmark.');
  if (request.clockSha256 && request.clockSha256 !== backend.clockSha256) throw new Error('Clock helper changed during the benchmark.');
  if (mode === 'prepare') return { preparationMs: performance.now() - start,
    driverSha256: backend.driverSha256, clockSha256: backend.clockSha256, compilerGitHash: backend.compilerGitHash };
  if (mode === 'compact') {
    const p = await capture({ file, extensionRoot: root, output,signal:controller.signal });
    const indexStart=performance.now();
    const rows=buildFileIndex(p,path.relative(project,file).split(path.sep).join('/'));
    await fs.writeFile(output+'.index.jsonl',rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    return { frontendMs: p.elapsedMs, exportPreparationMs: p.exportPreparationMs,
      indexExportMs:performance.now()-indexStart,clockCalibration:p.clockCalibration,
      events: p.nodes.length, declarations: p.declarations.length, bytes: (await fs.stat(output)).size };
  }
  if (mode === 'baseline') {
    await runProcess(backend.executable, [file, output, '1', 'baseline'], project, controller.signal, undefined, backend.env);
    const p = JSON.parse(await fs.readFile(output, 'utf8'));
    return { frontendMs: p.elapsedMs };
  }
  if (mode === 'native') {
    await runProcess(backend.leanExecutable, [...(setup ? ['--setup', setup] : []), file], project, controller.signal, undefined, backend.env);
    return {};
  }
  throw new Error('Unknown benchmark mode.');
}
(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    try { console.log(JSON.stringify({ ok: true, ...await run(JSON.parse(line)) })); }
    catch (error) { console.log(JSON.stringify({ ok: false, error: error.stack })); }
  }
})();
