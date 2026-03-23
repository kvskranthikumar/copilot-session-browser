import * as vscode from 'vscode';
import { IndexService } from '../services/indexService';
import { SessionListItem, WorkspaceInfo } from '../models/types';

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class SessionListProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotSessionBrowser.sessionList';

  private _view?: vscode.WebviewView;
  private _discoveredWorkspaces: WorkspaceInfo[] = [];
  private _workspaceScanner?: () => WorkspaceInfo[];
  private static _out: vscode.OutputChannel | undefined;

  /** Shared output channel — call once from activate() */
  static initOutput(): void {
    if (!SessionListProvider._out) {
      SessionListProvider._out = vscode.window.createOutputChannel('Copilot Session Browser');
    }
  }

  static log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}`;
    SessionListProvider._out?.appendLine(line);
    console.log('[CopilotSessionBrowser]', msg);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: IndexService,
  ) {}

  setDiscoveredWorkspaces(workspaces: WorkspaceInfo[]): void {
    this._discoveredWorkspaces = workspaces;
  }

  /**
   * Provide a SYNCHRONOUS callback that lists workspace folders.
   * Called every time the webview opens so the list is always up-to-date.
   */
  setWorkspaceScanner(fn: () => WorkspaceInfo[]): void {
    this._workspaceScanner = fn;
    SessionListProvider.log('setWorkspaceScanner called — scanner is now set');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    SessionListProvider.log(`resolveWebviewView called — _workspaceScanner is ${this._workspaceScanner ? 'SET' : 'UNSET'}`);
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'ready':
          // Scan workspace folders synchronously before sending sessions so the
          // workspace list is always populated on first open (no async gap).
          if (this._workspaceScanner) {
            this._discoveredWorkspaces = this._workspaceScanner();
          }
          this._sendSessions();
          break;
        case 'openSession':
          void vscode.commands.executeCommand(
            'copilotSessionBrowser.viewSession',
            msg.sessionId as string,
          );
          break;
        case 'summarizeShort':
          void vscode.commands.executeCommand(
            'copilotSessionBrowser.summarizeShort',
            msg.sessionId as string,
          );
          break;
        case 'summarizeDetailed':
          void vscode.commands.executeCommand(
            'copilotSessionBrowser.summarizeDetailed',
            msg.sessionId as string,
          );
          break;
        case 'exportSession':
          void vscode.commands.executeCommand(
            'copilotSessionBrowser.exportSession',
            msg.sessionId as string,
          );
          break;
        case 'refresh':
          void vscode.commands.executeCommand('copilotSessionBrowser.refresh');
          break;
        case 'import':
          void vscode.commands.executeCommand('copilotSessionBrowser.importSession');
          break;
        case 'diagnostics':
          void vscode.commands.executeCommand('copilotSessionBrowser.diagnostics');
          break;
      }
    });
  }

  /** Push updated session list to the webview */
  refresh(): void {
    this._sendSessions();
  }

  setStatusMessage(msg: string): void {
    this._view?.webview.postMessage({ type: 'status', message: msg });
  }

  private _sendSessions(): void {
    if (!this._view) {
      SessionListProvider.log('_sendSessions: no view — skipping');
      return;
    }

    const sessions = this.index.query({}, 'updatedAt', 'desc');
    const items: SessionListItem[] = this.index.toListItems(sessions);
    const tags = this.index.allTags();
    const workspaces = this.index.allWorkspaces();

    SessionListProvider.log(
      `_sendSessions: items=${items.length} discoveredWorkspaces=${this._discoveredWorkspaces.length} workspaceContexts=${workspaces.length}`,
    );

    // Log first few session workspace contexts so we can diagnose matching issues
    if (items.length > 0) {
      const sample = items.slice(0, 5);
      for (const it of sample) {
        SessionListProvider.log(`  item: id=${it.id.substring(0, 8)} ws="${(it.workspaceContext ?? '').substring(0, 60)}" title="${it.title.substring(0, 40)}"`);
      }
    }
    if (this._discoveredWorkspaces.length > 0) {
      const sample = this._discoveredWorkspaces.slice(0, 5);
      for (const w of sample) {
        SessionListProvider.log(`  workspace: hash=${w.hash} label="${w.label}" folderPath="${(w.folderPath ?? '').substring(0, 60)}"`);
      }
    }

    this._view.webview.postMessage({
      type: 'sessions',
      items,
      tags,
      workspaces,
      discoveredWorkspaces: this._discoveredWorkspaces,
      count: items.length,
    });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'sessionList.js'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
    ].join('; ');

    // Scan workspace folders NOW (sync) and embed directly in HTML.
    // This guarantees the list renders on first paint with zero message-passing.
    SessionListProvider.log(`_buildHtml: _workspaceScanner is ${this._workspaceScanner ? 'SET' : 'UNSET'}`);
    let initialWorkspaces: WorkspaceInfo[] = [];
    if (this._workspaceScanner) {
      try {
        initialWorkspaces = this._workspaceScanner();
        SessionListProvider.log(`_buildHtml: scanner returned ${initialWorkspaces.length} workspaces`);
        if (initialWorkspaces.length > 0) {
          SessionListProvider.log(`_buildHtml: first 3 → ${initialWorkspaces.slice(0, 3).map(w => `${w.label}(${w.hash.slice(0,6)})`).join(', ')}`);
        }
      } catch (e) {
        SessionListProvider.log(`_buildHtml: scanner THREW → ${e}`);
      }
    } else {
      SessionListProvider.log('_buildHtml: no scanner — wsJson will be []');
    }
    const wsJson = JSON.stringify(initialWorkspaces);

    // ── Server-side render workspace list as real HTML ──────────────────────
    // This makes the list visible even if JavaScript is completely blocked.
    const esc = (s: string): string =>
      String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
               .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

    const preRenderedList: string = initialWorkspaces.length === 0
      ? '<div style="display:flex;flex-direction:column;align-items:center;padding:32px 16px;text-align:center;opacity:0.7;gap:12px">' +
        '<div style="font-size:32px">💬</div>' +
        '<p style="font-size:12px;line-height:1.5">No workspaces found.<br>Check Settings → Override Storage Path.</p></div>'
      : '<button class="all-sessions-btn" id="srv-btn-all" data-key="__all__">📋 All sessions (loading…)</button>' +
        initialWorkspaces.map(w => {
          const key = esc(w.folderPath || w.hash);
          const label = esc(w.label);
          const fullPath = esc(w.folderPath || w.hash);
          return `<button class="ws-item" data-key="${key}" title="${fullPath}">` +
                 `<span class="ws-icon">📁</span>` +
                 `<div class="ws-info">` +
                 `<div class="ws-name">${label}</div>` +
                 `<div class="ws-meta">—</div>` +
                 `</div>` +
                 `<span class="ws-arrow">›</span>` +
                 `</button>`;
        }).join('');

    const preRenderedStatus = `${initialWorkspaces.length} workspace${initialWorkspaces.length !== 1 ? 's' : ''}`;

    // Safely embed JSON in HTML: encode < > & to prevent HTML injection
    const wsJsonEmbedded = wsJson.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Copilot Sessions</title>
  <style>
    :root {
      --accent: var(--vscode-focusBorder, #007acc);
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-foreground, var(--vscode-sideBar-foreground, #fff));
      --item-bg: var(--vscode-list-inactiveSelectionBackground);
      --item-hover: var(--vscode-list-hoverBackground);
      --item-active: var(--vscode-list-activeSelectionBackground);
      --item-active-fg: var(--vscode-list-activeSelectionForeground);
      --border: var(--vscode-panel-border, #444);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .toolbar input {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, var(--border));
      border-radius: 2px;
      padding: 4px 6px;
      font-size: inherit;
      outline: none;
    }
    .toolbar input:focus { border-color: var(--accent); }
    .toolbar select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, var(--border));
      border-radius: 2px;
      padding: 4px 4px;
      font-size: inherit;
      cursor: pointer;
    }
    .filter-bar {
      display: flex;
      gap: 4px;
      padding: 4px 8px;
      flex-shrink: 0;
      flex-wrap: wrap;
      border-bottom: 1px solid var(--border);
    }
    .filter-btn {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .filter-btn:hover { background: var(--item-hover); }
    .filter-btn.active {
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-color: transparent;
    }
    #session-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 0;
    }
    .session-item {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      color: var(--fg);
      padding: 8px 12px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.1s, border-color 0.1s;
      position: relative;
    }
    .session-item:hover { background: var(--item-hover); border-left-color: var(--accent); }
    .session-item:focus {
      outline: none;
      background: var(--item-active);
      color: var(--item-active-fg);
      border-left-color: var(--accent);
    }
    .session-title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 3px;
    }
    .session-meta {
      font-size: 11px;
      opacity: 0.7;
      display: flex;
      gap: 10px;
    }
    .session-tags {
      margin-top: 3px;
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .tag {
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-radius: 8px;
      padding: 1px 6px;
      font-size: 10px;
    }
    .context-menu {
      display: none;
      position: absolute;
      right: 8px;
      top: 8px;
      background: var(--vscode-menu-background, var(--bg));
      border: 1px solid var(--border);
      border-radius: 4px;
      z-index: 100;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .session-item:hover .ctx-trigger { opacity: 1; }
    .ctx-trigger {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      opacity: 0;
      background: transparent;
      border: none;
      color: var(--fg);
      cursor: pointer;
      font-size: 16px;
      padding: 2px 4px;
      border-radius: 2px;
      line-height: 1;
    }
    .ctx-trigger:focus { opacity: 1; outline: 1px solid var(--accent); }
    .ctx-menu {
      display: none;
      position: fixed;
      background: var(--vscode-menu-background, var(--input-bg));
      border: 1px solid var(--border);
      border-radius: 4px;
      z-index: 1000;
      min-width: 180px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      padding: 4px 0;
    }
    .ctx-menu.open { display: block; }
    .ctx-menu button {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      color: var(--fg);
      border: none;
      padding: 6px 16px;
      cursor: pointer;
      font-size: inherit;
    }
    .ctx-menu button:hover { background: var(--item-hover); }
    #empty-state {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 32px 16px;
      text-align: center;
      opacity: 0.7;
    }
    #empty-state.visible { display: flex; }
    .empty-icon { font-size: 32px; }
    #empty-state p { font-size: 12px; line-height: 1.5; }
    .empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    #status-bar {
      padding: 4px 8px;
      font-size: 11px;
      opacity: 0.6;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    /* ── Extra CSS for workspace view ───────────────────────────── */
    .ws-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      color: var(--fg);
      padding: 9px 12px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.1s, border-color 0.1s;
    }
    .ws-item:hover { background: var(--item-hover); border-left-color: var(--accent); }
    .ws-item:focus {
      outline: none;
      background: var(--item-active);
      color: var(--item-active-fg);
      border-left-color: var(--accent);
    }
    .ws-icon { font-size: 16px; flex-shrink: 0; }
    .ws-info { min-width: 0; flex: 1; }
    .ws-name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ws-meta { font-size: 11px; opacity: 0.65; margin-top: 2px; }
    .ws-arrow { opacity: 0.4; margin-left: auto; flex-shrink: 0; }
    .breadcrumb-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-width: 0;
    }
    .btn-back {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 2px;
      padding: 3px 7px;
      font-size: 11px;
      cursor: pointer;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .btn-back:hover { background: var(--item-hover); }
    .breadcrumb-name {
      font-size: 12px;
      font-weight: 500;
      opacity: 0.85;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .all-sessions-btn {
      display: block;
      width: calc(100% - 16px);
      margin: 6px 8px 2px;
      text-align: left;
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--fg);
      padding: 7px 10px;
      cursor: pointer;
      border-radius: 2px;
      font-size: inherit;
      opacity: 0.75;
    }
    .all-sessions-btn:hover { opacity: 1; background: var(--item-hover); }
    #workspace-view, #session-view {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
  </style>
</head>
<body>

  <!-- ══ View 1: Workspace Picker ══════════════════════════════════════════ -->
  <div id="workspace-view">
    <div class="toolbar" role="search">
      <input id="ws-search" type="search" placeholder="Filter workspaces…" aria-label="Filter workspaces">
    </div>
    <div class="filter-bar" id="ws-filter-bar">
      <button class="filter-btn" data-wsfilter="all">All</button>
      <button class="filter-btn active" data-wsfilter="with-sessions">With sessions</button>
    </div>
    <div id="workspace-list" role="list" style="flex:1;min-height:0;overflow-y:auto;">${preRenderedList}</div>
    <div id="status-bar" aria-live="polite">${preRenderedStatus}</div>
  </div>

  <!-- ══ View 2: Sessions for a Workspace ══════════════════════════════════ -->
  <div id="session-view" style="display:none">
    <div class="breadcrumb-bar">
      <button class="btn-back" id="btn-back">← Workspaces</button>
      <span class="breadcrumb-name" id="ws-breadcrumb-name" title=""></span>
    </div>
    <div class="toolbar" role="search">
      <input id="search" type="search" placeholder="Search sessions…" aria-label="Search sessions">
      <select id="sort" aria-label="Sort sessions">
        <option value="updatedAt|desc">Newest first</option>
        <option value="createdAt|desc">Date created ↓</option>
        <option value="createdAt|asc">Date created ↑</option>
        <option value="title|asc">Title A–Z</option>
        <option value="title|desc">Title Z–A</option>
        <option value="messageCount|desc">Most messages</option>
      </select>
    </div>
    <div class="filter-bar" role="group" aria-label="Date filter">
      <button class="filter-btn active" data-period="all">All</button>
      <button class="filter-btn" data-period="today">Today</button>
      <button class="filter-btn" data-period="week">Week</button>
      <button class="filter-btn" data-period="month">Month</button>
      <button class="filter-btn" data-period="imported" title="Only imported sessions">Imported</button>
    </div>
    <div id="session-list" role="list" aria-label="Chat sessions" style="flex:1;min-height:0;overflow-y:auto;padding:4px 0;"></div>
    <div id="empty-state" role="status" aria-live="polite" style="display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px 16px;text-align:center;opacity:0.7">
      <div class="empty-icon">💬</div>
      <p id="empty-message">No sessions match the current filter.</p>
    </div>
    <div id="session-status-bar" aria-live="polite" style="padding:4px 8px;font-size:11px;opacity:0.6;border-top:1px solid var(--border);flex-shrink:0"></div>
  </div>

  <!-- Shared context menu -->
  <div class="ctx-menu" id="ctx-menu" role="menu">
    <button id="ctx-view" role="menuitem">🔍 View Transcript</button>
    <button id="ctx-sum-short" role="menuitem">📋 Summarize (Short)</button>
    <button id="ctx-sum-detail" role="menuitem">📄 Summarize (Detailed)</button>
    <button id="ctx-export" role="menuitem">💾 Export…</button>
  </div>

  <!-- Workspace JSON data — read by sessionList.js, invisible to user -->
  <div id="__ws_data__" style="display:none" aria-hidden="true">${wsJsonEmbedded}</div>

  <!-- External script — loaded via webview.asWebviewUri, allowed by script-src ${webview.cspSource} -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
