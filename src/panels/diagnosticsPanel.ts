import * as vscode from 'vscode';
import { DiagnosticsInfo } from '../models/types';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badge(ok: boolean): string {
  return ok ? '✅' : '❌';
}

export class DiagnosticsPanel {
  public static readonly viewType = 'copilotSessionBrowser.diagnostics';

  private static _panel: DiagnosticsPanel | undefined;

  public static openOrReveal(
    diagnostics: DiagnosticsInfo,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.One,
  ): void {
    if (DiagnosticsPanel._panel) {
      DiagnosticsPanel._panel._panel.reveal(column);
      DiagnosticsPanel._panel._update(diagnostics);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DiagnosticsPanel.viewType,
      'Copilot Session Browser – Diagnostics',
      column,
      { enableScripts: true },
    );

    DiagnosticsPanel._panel = new DiagnosticsPanel(panel, diagnostics);
  }

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, diagnostics: DiagnosticsInfo) {
    this._panel = panel;
    this._panel.webview.html = this._buildHtml(diagnostics);

    this._panel.onDidDispose(() => {
      DiagnosticsPanel._panel = undefined;
      this._disposables.forEach(d => d.dispose());
    }, null, this._disposables);

    this._panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'refresh') {
        void vscode.commands.executeCommand('copilotSessionBrowser.refresh');
      }
    }, null, this._disposables);
  }

  private _update(diagnostics: DiagnosticsInfo): void {
    this._panel.webview.html = this._buildHtml(diagnostics);
  }

  private _buildHtml(d: DiagnosticsInfo): string {
    const nonce = getNonce();
    const webview = this._panel.webview;
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const searchPathsHtml = d.searchPaths.map(sp => `
      <tr>
        <td>${badge(sp.exists)} <code>${escHtml(sp.path)}</code></td>
        <td>${sp.exists ? (sp.fileCount ?? '?') + ' file(s)' : 'Not found'}</td>
        <td>${sp.files ? sp.files.map(f => `<code>${escHtml(f)}</code>`).join('<br>') : ''}</td>
      </tr>`).join('');

    const discoveredHtml = d.discoveredFiles.length === 0
      ? '<tr><td colspan="4"><em>No session files found.</em></td></tr>'
      : d.discoveredFiles.map(r => {
          const tableInfo = r.tableNames && r.tableNames.length > 0
            ? `<br><span class="info">Tables: ${r.tableNames.map(t => `<code>${escHtml(t)}</code>`).join(', ')}</span>`
            : '';
          const icon = r.type === 'json' ? '\u2705'
            : r.sessionCount > 0 ? '\u2705'
            : r.type === 'sqlite' ? '\u26a0\ufe0f' : '\u2753';
          return `
        <tr>
          <td>${icon}</td>
          <td><code>${escHtml(r.path)}</code></td>
          <td>${escHtml(r.type)} / ${escHtml(r.schemaVersion)}</td>
          <td>${r.sessionCount} session(s)${tableInfo}${r.errors.length ? '<br><span class="warn">' + r.errors.map(e => escHtml(e)).join('<br>') + '</span>' : ''}</td>
        </tr>`;}).join('');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Diagnostics</title>
  <style>
    :root {
      --fg: var(--vscode-editor-foreground);
      --bg: var(--vscode-editor-background);
      --border: var(--vscode-panel-border, #444);
      --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      padding: 20px 24px 48px;
      line-height: 1.6;
    }
    h1 { font-size: 18px; margin-bottom: 16px; }
    h2 { font-size: 14px; margin: 20px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    .summary-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 8px 0; }
    .label { opacity: 0.7; }
    code {
      background: var(--code-bg);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      word-break: break-all;
    }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--border); opacity: 0.8; }
    td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:hover td { background: rgba(255,255,255,0.04); }
    .warn { color: var(--vscode-inputValidation-warningForeground, #cca700); font-size: 11px; }
    .info { color: var(--vscode-descriptionForeground, #888); font-size: 11px; }
    .note {
      background: var(--vscode-inputValidation-infoBackground, #1a3a5c);
      border: 1px solid var(--vscode-inputValidation-infoBorder, #4e9fd5);
      border-radius: 4px;
      padding: 10px 14px;
      margin: 12px 0;
      font-size: 12px;
      line-height: 1.6;
    }
    .btn {
      background: var(--btn-bg); color: var(--btn-fg); border: none;
      border-radius: 2px; padding: 5px 12px; cursor: pointer; margin-top: 12px;
    }
    .btn:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <h1>🔍 Copilot Session Browser — Diagnostics</h1>

  <h2>Summary</h2>
  <div class="summary-grid">
    <span class="label">OS:</span><span>${escHtml(d.osType)}</span>
    <span class="label">Run at:</span><span>${escHtml(d.timestamp.toLocaleString())}</span>
    <span class="label">Sessions loaded:</span><span>${d.totalSessionsLoaded}</span>
    <span class="label">Errors:</span><span>${d.errors.length === 0 ? '✅ None' : d.errors.map(e => escHtml(e)).join('<br>')}</span>
  </div>

  <h2>VS Code Data Paths Searched</h2>
  <table>
    <thead><tr><th>Path &amp; Status</th><th>Files</th><th>File names (first 50)</th></tr></thead>
    <tbody>${searchPathsHtml}</tbody>
  </table>

  <h2>Discovered Session Files</h2>
  <table>
    <thead><tr><th>Status</th><th>Path</th><th>Type / Schema</th><th>Sessions</th></tr></thead>
    <tbody>${discoveredHtml}</tbody>
  </table>

  <div class="note">
    <strong>\u2139\ufe0f SQLite support</strong><br>
    This extension can read SQLite databases used by GitHub Copilot Chat.
    It tries several known schemas (<code>ItemTable</code>, direct conversation tables).
    If sessions are still not found, the file may contain workspace code-index data
    (e.g. <code>workspace-chunks.db</code>) rather than chat history.<br><br>
    <strong>Workarounds if no sessions appear:</strong>
    <ul style="margin:6px 0 0 18px">
      <li>Use <em>Set Storage Path Override</em> command to point directly at your <code>workspaceStorage</code> or <code>globalStorage</code> folder.</li>
      <li>Export sessions from Copilot Chat manually, then use <em>Import Session</em>.</li>
      <li>Check <em>Additional Search Paths</em> in extension settings for custom locations.</li>
    </ul>
  </div>

  <button class="btn" id="btn-refresh">↻ Refresh Index</button>

  <script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  </script>
</body>
</html>`;
  }
}
