const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareBackend } = require('../out/capture.js');
test('native cache reuses verified builds, preserves Lake environment and recovers corruption', { skip: process.platform === 'win32' }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-cache-'));
  let cached;
  try {
    await fs.mkdir(path.join(temp, 'lean'));
    await fs.writeFile(path.join(temp, 'lean', 'SourceProfiler.lean'), 'unique test driver ' + temp);
    await fs.writeFile(path.join(temp, 'lean', 'Clock.c'), 'unique clock fixture');
    await fs.writeFile(path.join(temp, 'lean-toolchain'), 'test toolchain');
    const calls = path.join(temp, 'calls'), lake = path.join(temp, 'lake');
    await fs.writeFile(lake, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--githash')) {console.log('test-cache');process.exit(0);}
if(process.argv.includes('--print-prefix')) {console.log(${JSON.stringify(temp)});process.exit(0);}
if(process.argv.length===3) {console.log('LEAN_PATH=path=with equals');process.exit(0);}
if(process.argv[3]==='lean') fs.writeFileSync(process.argv[process.argv.indexOf('-c')+1],'C');
if(process.argv[3]==='leanc') {fs.appendFileSync(${JSON.stringify(calls)},'build\\n');fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'verified binary');}
`);
    await fs.chmod(lake, 0o755);
    const first = await prepareBackend(temp, lake, temp); cached = path.dirname(first.executable);
    const second = await prepareBackend(temp, lake, temp);
    assert.equal(first.executable, second.executable);
    assert.equal(second.env.LEAN_PATH, 'path=with equals');
    assert.equal(await fs.readFile(calls, 'utf8'), 'build\n');
    await fs.writeFile(first.executable, 'corrupt binary with changed size');
    const repaired = await prepareBackend(temp, lake, temp);
    assert.equal(await fs.readFile(repaired.executable, 'utf8'), 'verified binary');
    assert.equal(await fs.readFile(calls, 'utf8'), 'build\nbuild\n');
  } finally {
    if(cached) {
      for(const entry of await fs.readdir(path.dirname(cached))) if(entry===path.basename(cached)||entry.startsWith(path.basename(cached)+'-invalid-')) await fs.rm(path.join(path.dirname(cached),entry),{recursive:true,force:true});
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
});
