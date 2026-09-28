const vscode=require('vscode');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');

exports.run=async function () {
  const root=process.env.LEAN_PROFILE_TEST_ROOT;
  const source=path.join(root,'test','fixtures','SourceProfileFixtures','Accuracy.lean');
  const extension=vscode.extensions.getExtension('local-lean-tools.lean-source-profiler');
  assert.ok(extension,'extension is installed in development host');
  const api=await extension.activate();
  const commands=await vscode.commands.getCommands();
  for(const command of ['profileFolder','profileProject','chooseSessionFile','view']) {
    assert.ok(commands.includes(`leanSourceProfiler.${command}`),`session command ${command} is registered`);
  }
  await vscode.workspace.getConfiguration('editor').update('codeLens',true,vscode.ConfigurationTarget.Workspace);
  const document=await vscode.workspace.openTextDocument(source);
  await vscode.window.showTextDocument(document);
  const profile=await api.profileFile(document.uri);
  assert.ok(profile?.nodes.length>0,'Profile button produces recording and returns it');
  assert.ok(profile.profilePath.endsWith('.leanprofile.json'));
  assert.equal(JSON.parse(await fs.readFile(profile.profilePath,'utf8')).sourceFile,source);
  const getLenses=async(uri=document.uri)=> (await vscode.commands.executeCommand('vscode.executeCodeLensProvider',uri))?.filter(l=>l.command?.command==='leanSourceProfiler.inspectNode')??[];
  let lenses=await getLenses();
  assert.ok(lenses.length>=10,`source has >=10 timing lenses, got ${lenses.length}`);
  const expected=JSON.parse(await fs.readFile(path.join(root,'test','fixtures','expected-ranges.json'),'utf8'));
  // Exact tactic invocation locations include repeated and multiline syntax; UI shows a bar per start line.
  assert.ok(lenses.some(l=>l.range.start.line===7),'funext line has a clickable annotation');
  assert.ok(lenses.some(l=>l.range.start.line===8),'exact line has a separate annotation');
  const exact=profile.nodes.find(n=>n.category==='Source.tactic'&&n.label.endsWith('.exact')&&n.source?.start.line===8);
  assert.ok(exact);
  await vscode.commands.executeCommand('leanSourceProfiler.inspectNode',exact.id);
  const selectedEditor=vscode.window.visibleTextEditors.find(e=>e.document.uri.fsPath===source);
  assert.equal(selectedEditor.selection.start.line,8,'clicking timing selects correct tactic');
  const navNode=profile.nodes.find(n=>n.symbols?.some(s=>s.file?.endsWith('Imported.lean')&&s.range));
  assert.ok(navNode,'semantic imported definition links recorded');
  const symbolIndex=navNode.symbols.findIndex(s=>s.file?.endsWith('Imported.lean')&&s.range);
  await vscode.commands.executeCommand('leanSourceProfiler.openSymbol',navNode.id,symbolIndex);
  assert.ok(vscode.window.visibleTextEditors.some(e=>e.document.uri.fsPath.endsWith('Imported.lean')),'definition navigation opens other source');
  await vscode.window.showTextDocument(document,vscode.ViewColumn.One);
  const change=new vscode.WorkspaceEdit();change.insert(document.uri,new vscode.Position(0,0),'-- changed after capture\n');
  await vscode.workspace.applyEdit(change);
  assert.equal((await getLenses()).length,0,'stale buffer suppresses timing annotations');
  const restore=new vscode.WorkspaceEdit();restore.delete(document.uri,new vscode.Range(0,0,1,0));
  await vscode.workspace.applyEdit(restore);
  assert.ok((await getLenses()).length>=10,'exact restoration restores annotations');
  await vscode.commands.executeCommand('leanSourceProfiler.toggleOverlay');
  assert.equal((await getLenses()).length,0,'toggle hides annotations');
  await vscode.commands.executeCommand('leanSourceProfiler.toggleOverlay');
  assert.ok((await getLenses()).length>=10);
  await vscode.commands.executeCommand('leanSourceProfiler.clear');
  assert.equal((await getLenses()).length,0,'clear removes annotation provider output');
  await api.openProfile(profile.profilePath);
  assert.ok((await getLenses()).length>=10,'open saved recording restores overlays without re-elaboration');
  await fs.mkdir(path.join(root,'test','results'),{recursive:true});
  // Generate a fresh recording with the exact extension package's capture code
  // and driver. The checked-in UI sample is useful manually, but not a test dependency.
  const sessionTemp=await fs.mkdtemp(path.join(root,'test','results','extension-session-'));
  let sessionResult;
  try {
    const {captureSession}=require(path.join(extension.extensionPath,'out','collection.js'));
    const session=await captureSession({target:path.join(root,'test','fixtures','CollectionSource'),
      extensionRoot:extension.extensionPath,output:path.join(sessionTemp,'recording'),thresholdMs:0});
    assert.equal(session.status,'complete');
    assert.equal(session.files.length,2);
    assert.ok(session.files.every(file=>file.status==='ok'));
    assert.equal(typeof api.sessions?.openFile,'function','session files can be selected without a native quick pick');

    const alpha=await api.sessions.openFile(session.sessionPath,'0');
    const alphaSource=path.join(root,'test','fixtures','CollectionSource','Alpha.lean');
    assert.equal(alpha.sourceFile,alphaSource);
    const alphaDocument=await vscode.workspace.openTextDocument(alphaSource);
    assert.equal(alphaDocument.getText(),alpha.sourceText,'first file matches its recorded source snapshot');
    let alphaLenses=await getLenses(alphaDocument.uri);
    assert.ok(alphaLenses.length>0,'opening first session file creates timing lenses');
    assert.ok(alphaLenses.some(l=>l.range.start.line===3),'first session file exact tactic is annotated');
    assert.equal((await getLenses(document.uri)).length,0,'old single-file overlays do not leak into the selected session file');

    const beta=await api.sessions.openFile(session.sessionPath,'1');
    const betaSource=path.join(root,'test','fixtures','CollectionSource','nested','Beta.lean');
    assert.equal(beta.sourceFile,betaSource);
    const betaDocument=await vscode.workspace.openTextDocument(betaSource);
    assert.equal(betaDocument.getText(),beta.sourceText,'nested file matches its recorded source snapshot');
    const betaLenses=await getLenses(betaDocument.uri);
    assert.ok(betaLenses.length>0,'switching to nested session file creates its timing lenses');
    const multilineLens=betaLenses.find(l=>l.range.start.line===8);
    assert.ok(multilineLens,'nested file multiline exact has its own source annotation');
    await vscode.commands.executeCommand(multilineLens.command.command,...multilineLens.command.arguments);
    const betaEditor=vscode.window.visibleTextEditors.find(e=>e.document.uri.fsPath===betaSource);
    assert.ok(betaEditor,'session switch shows the nested source editor');
    assert.equal(betaEditor.selection.start.line,8,'session CodeLens selects the correct file and syntax line');
    assert.equal((await getLenses(alphaDocument.uri)).length,0,'switching session files removes previous file timing lenses');

    await api.openProfile(profile.profilePath);
    assert.ok((await getLenses(document.uri)).length>=10,'opening an older single-file recording after a session restores original overlays');
    assert.equal((await getLenses(betaDocument.uri)).length,0,'single-file reopen removes nested session overlays');
    sessionResult={files:session.files.map(file=>({id:file.id,path:file.path,status:file.status})),wallMs:session.wallMs,
      alphaEvents:alpha.nodes.length,betaEvents:beta.nodes.length};
  } finally { await fs.rm(sessionTemp,{recursive:true,force:true}); }
  await fs.writeFile(path.join(root,'test','results','extension-host.json'),JSON.stringify({passed:true,vscode:vscode.version,
    extensionPath:extension.extensionPath,profile:profile.profilePath,events:profile.nodes.length,session:sessionResult,
    checks:['capture command','source CodeLens','tactic selection','imported definition navigation','stale source suppression',
      'restoration','toggle','clear','open saved recording','session command registration','fresh multi-file capture',
      'session first-file overlay','session nested-file switching','session source snapshots','session CodeLens selection',
      'cross-file overlay isolation','legacy single-file reopen after session']},null,2));
  console.log('Extension-host integration checks passed.');
};
