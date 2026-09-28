import * as http from 'node:http';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { readSession, readSessionProfile, readIndex, sessionProfilePath } from './collection';
import type { Profile } from './model';

export function renderViewerHtml(options: { published?: boolean } = {}): string {
  const assetRoot = options.published ? './' : '/';
  const footer = options.published
    ? 'Public example<br><span>Published recording · read-only.</span>'
    : 'Local recording<br><span>No source leaves this laptop.</span>';
  return `<!doctype html>
<html lang="en" data-recording-mode="${options.published ? 'static' : 'local'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Lean Source Profiler</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${assetRoot}viewer.css"><script src="${assetRoot}viewer.js" defer></script></head>
<body><div class="app-shell"><aside class="sidebar"><a class="brand" href="#"><span class="brand-mark" aria-hidden="true">▰</span><span>LEAN<span class="brand-sub">SOURCE PROFILER</span></span></a><div class="sidebar-heading">RECORDING</div><div id="recording-name" class="recording-name">Loading recording…</div><nav id="folder-tree" aria-label="Repository folders"></nav><div class="sidebar-foot"><span class="local-dot"></span> ${footer}</div></aside><main id="main"><header class="page-header"><div><div class="eyebrow">ELABORATION / PERFORMANCE</div><h1 id="page-title">Reading your profile…</h1><p id="page-subtitle" class="subtitle">Loading saved timing data.</p></div><div id="header-actions" class="header-actions"></div></header><div id="publication-info" class="notice publication-info" hidden></div><div id="notice" class="notice" hidden role="status"></div><div id="stats" class="stats"></div><nav id="breadcrumbs" class="breadcrumbs" aria-label="Location"></nav><div id="content"><div class="loading">Loading…</div></div><footer class="main-footer">Elapsed trace time, including nested work. Source-line and operation times overlap; do not add them together.</footer></main></div><div id="toast" class="toast" role="status" hidden></div></body></html>`;
}

function launchBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => { /* The URL returned to the CLI remains usable if no browser is installed. */ });
  child.unref();
}

/** Serve a saved recording, never arbitrary files, on an ephemeral loopback port. */
export async function startViewer(recordingPath: string, options: { port?: number; open?: boolean } = {}): Promise<{ url: string; close(): Promise<void> }> {
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error('Viewer port must be an integer between 0 and 65535.');
  }
  const session = await readSession(path.resolve(recordingPath));
  const [javascript, stylesheet] = await Promise.all([
    readFile(path.resolve(__dirname, '../media/viewer.js')),
    readFile(path.resolve(__dirname, '../media/viewer.css')),
  ]);
  const files = new Map(session.files.map(file => [file.id, file]));
  const profiles = new Map<string, Promise<Profile>>();
  let index: ReturnType<typeof readIndex> | undefined;
  let origin = '';
  const summary = {
    ...session,
    files: await Promise.all(session.files.map(async file => {
      let openInVSCode: string | undefined;
      if (file.profile) {
        try { openInVSCode = `vscode://local-lean-tools.lean-source-profiler/open?file=${encodeURIComponent(await sessionProfilePath(session, file.id))}`; }
        catch { /* The file API reports missing/unsafe artifacts on demand; the rest remains viewable. */ }
      }
      return { ...file, openInVSCode };
    })),
  };

  const server = http.createServer((request, response) => {
    const send = (status: number, body: string | Buffer, contentType = 'application/json; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    void (async () => {
      if (request.method !== 'GET' && request.method !== 'HEAD') { send(405, JSON.stringify({ error: 'Only GET requests are supported.' })); return; }
      if (`http://${request.headers.host}` !== origin) { send(403, JSON.stringify({ error: 'Invalid viewer host.' })); return; }
      if (request.headers.origin && request.headers.origin !== origin) { send(403, JSON.stringify({ error: 'Cross-origin requests are not permitted.' })); return; }
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/') { send(200, renderViewerHtml(), 'text/html; charset=utf-8'); return; }
      if (url.pathname === '/viewer.js') { send(200, javascript, 'text/javascript; charset=utf-8'); return; }
      if (url.pathname === '/viewer.css') { send(200, stylesheet, 'text/css; charset=utf-8'); return; }
      if (url.pathname === '/api/session') { send(200, JSON.stringify(summary)); return; }
      if (url.pathname === '/api/file') {
        const id = url.searchParams.get('id');
        if (!id || !files.has(id)) { send(404, JSON.stringify({ error: 'Unknown recorded file.' })); return; }
        if (files.get(id)!.status !== 'ok' || !files.get(id)!.profile) { send(409, JSON.stringify({ error: files.get(id)!.error ?? 'This file was not captured successfully.' })); return; }
        let profile = profiles.get(id);
        if (!profile) {
          profile = readSessionProfile(session, id);
          profiles.set(id, profile);
          // Keep only two loaded profiles; repository recordings can contain large expression trees.
          if (profiles.size > 2) { profiles.delete(profiles.keys().next().value!); }
          profile.catch(() => { if (profiles.get(id) === profile) { profiles.delete(id); } });
        }
        send(200, JSON.stringify(await profile)); return;
      }
      if (url.pathname === '/api/index') {
        index ??= readIndex(session);
        try { send(200, JSON.stringify(await index)); } catch (error) { index = undefined; throw error; }
        return;
      }
      send(404, JSON.stringify({ error: 'Unknown viewer route.' }));
    })().catch(error => {
      if (!response.headersSent) { send(500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
      else { response.destroy(); }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Viewer did not bind to a TCP port.'); }
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/`;
  if (options.open !== false) { launchBrowser(url); }
  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
