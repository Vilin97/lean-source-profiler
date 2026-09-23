import * as vscode from 'vscode';
import * as path from 'node:path';
import { capture, readProfile } from './capture';
import { ProfileUI } from './ui';

export function activate(context: vscode.ExtensionContext) {
  const ui = new ProfileUI(context);
  const output = vscode.window.createOutputChannel('Lean Source Profiler');
  let running: AbortController | undefined;
  async function openProfile(file?: string | vscode.Uri) {
    try {
      // Editor-title menu commands receive the current .lean URI; that is not the recording to open.
      if (file instanceof vscode.Uri && !file.fsPath.endsWith('.json')) file = undefined;
      const uri = typeof file === 'string' ? vscode.Uri.file(file) : file ?? (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Lean source profile': ['json'] }, title: 'Open Lean source profile' }))?.[0];
      if (!uri) return;
      if (uri.scheme !== 'file') throw new Error('Choose a local recording file.');
      const profile = await readProfile(uri.fsPath);
      await ui.showProfile(profile);
      await context.workspaceState.update('lastProfile', uri.fsPath);
      return profile;
    } catch (error) { await vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error)); }
  }
  async function profileFile(uri?: vscode.Uri) {
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('Trust this workspace before running its Lean code. Saved profiles can still be viewed.'); return; }
    if (running) { await vscode.window.showInformationMessage('A Lean capture is already running. Cancel it in the progress notification before starting another.'); return; }
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(e => path.extname(e.document.uri.fsPath) === '.lean');
    uri ??= editor?.document.uri;
    if (!uri || uri.scheme !== 'file' || path.extname(uri.fsPath) !== '.lean') { await vscode.window.showInformationMessage('Open a saved Lean file, then choose Profile Current File.'); return; }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty) {
      if (await vscode.window.showInformationMessage('Save this file before profiling?', 'Save and Profile') !== 'Save and Profile') return;
      if (!(await doc.save())) return;
    }
    const file = uri.fsPath;
    const controller = new AbortController(); running = controller;
    output.clear();
    try {
      const config = vscode.workspace.getConfiguration('leanSourceProfiler', uri);
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Profiling ${path.basename(file)}`, cancellable: true }, async (progress, token) => {
        const cancel = token.onCancellationRequested(() => controller.abort());
        try {
          progress.report({ message: 'Capturing source ranges and elaboration timings…' });
          return await capture({ file, extensionRoot: context.extensionPath, thresholdMs: config.get<number>('thresholdMs', 1), lakePath: config.get<string>('lakePath', 'lake'), signal: controller.signal, onLog: s => {
            output.append(s);
            if (/format|render|export/i.test(s)) progress.report({ message: 'Elaboration complete; rendering expressions and saving the recording…' });
          } });
        } finally { cancel.dispose(); }
      });
      await ui.showProfile(result);
      await context.workspaceState.update('lastProfile', result.profilePath);
      output.appendLine(`\nSaved ${result.profilePath}`);
      void vscode.window.showInformationMessage(`Profile ready: ${result.nodes.length.toLocaleString()} events. Timing bars are visible in the source.`, 'Show Recording').then(action => {
        if (action === 'Show Recording' && result.profilePath) return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.profilePath));
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(message);
      if (controller.signal.aborted) await vscode.window.showInformationMessage('Lean profile capture cancelled.');
      else if (await vscode.window.showErrorMessage(message.slice(0, 1500), 'Show Capture Log') === 'Show Capture Log') output.show();
    } finally { running = undefined; }
  }
  context.subscriptions.push(ui, output,
    vscode.commands.registerCommand('leanSourceProfiler.profile', profileFile),
    vscode.commands.registerCommand('leanSourceProfiler.open', openProfile),
    vscode.window.registerUriHandler({ async handleUri(uri) {
      if (uri.path !== '/open') return;
      const file = new URLSearchParams(uri.query).get('file');
      if (file && path.isAbsolute(file)) await openProfile(file);
    } }),
    { dispose() { running?.abort(); } }
  );
  return { openProfile, profileFile };
}
export function deactivate() {}
