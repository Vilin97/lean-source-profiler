const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProcess, findProjectRoot, readProfile } = require('../out/capture.js');

test('process arguments are literal, with no shell interpretation', async () => {
  const value = 'spaces $(echo should-not-run) `touch fake`';
  const text = await runProcess(process.execPath,['-e','process.stdout.write(process.argv[1])',value],process.cwd());
  assert.equal(text,value);
});
test('nonzero exit is surfaced with diagnostic text', async () => {
  await assert.rejects(runProcess(process.execPath,['-e','console.error("proof failed");process.exit(7)'],process.cwd()),/exit 7.*proof failed/s);
});
test('capture cancellation terminates the process', async () => {
  const controller = new AbortController();
  const promise = runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],process.cwd(),controller.signal);
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(promise,/cancelled/);
});
test('pre-cancelled process is never started', async () => {
  const controller = new AbortController();controller.abort();
  await assert.rejects(runProcess('/does-not-exist',[],process.cwd(),controller.signal),/cancelled/);
});
test('nearest nested Lake project wins over parent toolchain', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'lean-project-test-'));
  try {
    await fs.writeFile(path.join(root,'lean-toolchain'),'leanprover/lean4:v4.34.0-rc2');
    const nested=path.join(root,'nested'); await fs.mkdir(path.join(nested,'Lean'),{recursive:true});
    await fs.writeFile(path.join(nested,'lakefile.toml'),'name="test"');
    assert.equal(await findProjectRoot(path.join(nested,'Lean','File.lean')),nested);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test('malformed JSON error is readable', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lean-profile-test-'));
  try { const file=path.join(root,'bad.json'); await fs.writeFile(file,'{'); await assert.rejects(readProfile(file),/Could not read profile JSON/); }
  finally { await fs.rm(root,{recursive:true,force:true}); }
});
