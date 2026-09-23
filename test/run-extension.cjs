const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const root = path.resolve(__dirname,'..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(),'lean-profiler-vscode-test-'));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      extensionDevelopmentPath: process.env.LEAN_PROFILE_EXTENSION_PATH || root,
      extensionTestsPath: path.join(__dirname,'extension-host.cjs'),
      launchArgs: [path.join(__dirname,'fixtures'),'--user-data-dir',data,'--extensions-dir',path.join(data,'extensions'),'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-telemetry'],
      extensionTestsEnv: { LEAN_PROFILE_TEST_ROOT: root },
    });
  } finally { await fs.rm(data,{recursive:true,force:true}); }
})().catch(error => { console.error(error);process.exitCode=1; });
