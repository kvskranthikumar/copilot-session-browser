import * as vscode from 'vscode';
import { SessionWithMessages, SummaryOptions, ExportOptions } from '../models/types';
import { SummarizerService } from '../services/summarizerService';
import { ExporterService } from '../services/exporterService';
import { summarizeWithLlm } from '../services/llmSummarizerService';

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

/** Convert a minimal Markdown string to safe HTML (server-side, no client-side JS needed). */
function mdToHtml(md: string): string {
  const lines = md.split('\n');
  let html = '';
  let inPre = false;
  let preBuf: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeList = () => {
    if (inUl) { html += '</ul>\n'; inUl = false; }
    if (inOl) { html += '</ol>\n'; inOl = false; }
  };

  const inline = (s: string): string => {
    s = escHtml(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/_(.+?)_/g, '<em>$1</em>');
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    return s;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, ''); // strip Windows CR
    if (!inPre && /^```/.test(line)) {
      closeList();
      inPre = true;
      preBuf = [];
      continue;
    }
    if (inPre) {
      if (/^```/.test(line)) {
        const escaped = preBuf.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += '<pre><code>' + escaped + '</code></pre>\n';
        inPre = false; preBuf = [];
      } else {
        preBuf.push(line);
      }
      continue;
    }
    if (/^---+$/.test(line.trim())) { closeList(); html += '<hr>\n'; continue; }

    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) { closeList(); html += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>\n`; continue; }

    const ulm = line.match(/^\s*[-*]\s+(?:\[([ x])\]\s+)?(.+)/);
    if (ulm) {
      if (!inUl) { closeList(); html += '<ul>\n'; inUl = true; }
      const cb = ulm[1] !== undefined ? `<input type="checkbox"${ulm[1] === 'x' ? ' checked' : ''} disabled> ` : '';
      html += `<li>${cb}${inline(ulm[2])}</li>\n`;
      continue;
    }

    const olm = line.match(/^\s*\d+\.\s+(.+)/);
    if (olm) {
      if (!inOl) { closeList(); html += '<ol>\n'; inOl = true; }
      html += `<li>${inline(olm[1])}</li>\n`;
      continue;
    }

    closeList();
    if (line.trim() === '') { html += '\n'; continue; }
    if (/^>\s/.test(line)) { html += `<blockquote><p>${inline(line.slice(2))}</p></blockquote>\n`; continue; }
    html += `<p>${inline(line)}</p>\n`;
  }
  if (inPre && preBuf.length) {
    const escaped = preBuf.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html += '<pre><code>' + escaped + '</code></pre>\n';
  }
  closeList();
  return html;
}

const summarizer = new SummarizerService();
const exporter = new ExporterService();

export class SummaryPanel {
  public static readonly viewType = 'copilotSessionBrowser.summary';

  private static _panels = new Map<string, SummaryPanel>();

  public static openOrReveal(
    session: SessionWithMessages,
    options: SummaryOptions,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.Two,
  ): SummaryPanel {
    const key = session.id;
    const existing = SummaryPanel._panels.get(key);
    if (existing) {
      existing._panel.reveal(column);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      SummaryPanel.viewType,
      `Summary: ${session.title.slice(0, 30)}`,
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return new SummaryPanel(panel, session, options, key);
  }

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _options: SummaryOptions;
  private _summaryText: string = '';
  private _cts = new vscode.CancellationTokenSource();
  private _disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly session: SessionWithMessages,
    options: SummaryOptions,
    key: string,
  ) {
    this._panel = panel;
    this._options = options;
    SummaryPanel._panels.set(key, this);

    this._panel.webview.html = this._buildHtml('', true);
    void this._generate();

    this._panel.onDidDispose(
      () => {
        this._disposed = true;
        this._cts.cancel();
        this._cts.dispose();
        SummaryPanel._panels.delete(key);
        this._disposables.forEach(d => d.dispose());
      },
      null,
      this._disposables,
    );

    this._panel.webview.onDidReceiveMessage(
      async msg => {
        switch (msg.type) {
          case 'copyMarkdown':
            await vscode.env.clipboard.writeText(this._summaryText);
            void vscode.window.showInformationMessage('Summary copied to clipboard.');
            break;

          case 'saveMarkdown': {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(
                exporter.defaultFilename(session, 'markdown'),
              ),
              filters: { 'Markdown': ['md'] },
              title: 'Save Summary',
            });
            if (uri) {
              await vscode.workspace.fs.writeFile(
                uri,
                Buffer.from(this._summaryText, 'utf-8'),
              );
              void vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
            }
            break;
          }

          case 'exportFull': {
            void vscode.commands.executeCommand(
              'copilotSessionBrowser.exportSession',
              session.id,
            );
            break;
          }

          case 'regenerate': {
            this._options = {
              ...this._options,
              includeCodeBlocks: msg.includeCodeBlocks as boolean,
              redactSecrets: msg.redactSecrets as boolean,
            };
            this._cts.cancel();
            this._cts.dispose();
            this._cts = new vscode.CancellationTokenSource();
            this._panel.webview.html = this._buildHtml('', true);
            void this._generate();
            break;
          }
        }
      },
      null,
      this._disposables,
    );
  }

  private async _generate(): Promise<void> {
    const token = this._cts.token;
    try {
      const llmResult = await summarizeWithLlm(this.session, this._options, token);
      if (token.isCancellationRequested || this._disposed) { return; }
      this._summaryText = llmResult ?? summarizer.summarize(this.session, this._options);
    } catch (err) {
      if (token.isCancellationRequested || this._disposed) { return; }
      // Surface permission/blocked errors; fall back for everything else
      if (err instanceof vscode.LanguageModelError) {
        void vscode.window.showWarningMessage(
          `Copilot summarization failed: ${err.message}. Using built-in summarizer.`,
        );
      }
      this._summaryText = summarizer.summarize(this.session, this._options);
    }
    if (!this._disposed) {
      this._panel.webview.html = this._buildHtml(this._summaryText, false);
    }
  }

  private _buildHtml(markdownText: string, isLoading = false): string {
    const nonce = getNonce();
    const webview = this._panel.webview;
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    // Convert Markdown → HTML server-side (no client-side renderer needed)
    const renderedHtml = isLoading ? '' : mdToHtml(markdownText);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Summary</title>
  <style>
    :root {
      --fg: var(--vscode-editor-foreground);
      --bg: var(--vscode-editor-background);
      --border: var(--vscode-panel-border, #444);
      --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
      --header-bg: var(--vscode-sideBarSectionHeader-background);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --link: var(--vscode-textLink-foreground, #4daafc);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .toolbar {
      flex: 0 0 auto;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .toolbar-title {
      font-size: 13px;
      font-weight: 600;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar-options { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .toolbar-options label { display: flex; gap: 5px; align-items: center; font-size: 12px; cursor: pointer; }
    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 2px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .btn:hover { opacity: 0.85; }
    .btn-secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .warning-bar {
      flex: 0 0 auto;
      background: var(--vscode-inputValidation-warningBackground, #3d2e00);
      border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      color: var(--fg);
      padding: 4px 16px;
      font-size: 11px;
    }
    #scroll-area {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px 48px;
    }
    /* â”€â”€ Markdown rendering â”€â”€ */
    .md h1 { font-size: 1.4em; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    .md h2 { font-size: 1.15em; margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
    .md h3 { font-size: 1em; margin: 16px 0 6px; }
    .md p  { margin: 0 0 10px; line-height: 1.65; }
    .md ul, .md ol { margin: 0 0 10px 20px; line-height: 1.65; }
    .md li { margin: 2px 0; }
    .md li input[type=checkbox] { margin-right: 6px; }
    .md code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
      background: var(--code-bg);
      padding: 1px 5px;
      border-radius: 3px;
    }
    .md pre {
      background: var(--code-bg);
      border-radius: 4px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 0 0 12px;
    }
    .md pre code { background: none; padding: 0; }
    .md strong { font-weight: 600; }
    .md em { font-style: italic; }
    .md blockquote {
      border-left: 3px solid var(--border);
      padding-left: 12px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 10px;
    }
    .md hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
    .md a { color: var(--link); }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="toolbar-title">&#x1F4CB; Summary &mdash; ${escHtml(this.session.title.slice(0, 60))}</span>
    <div class="toolbar-options">
      <label title="Include code snippets in the summary">
        <input type="checkbox" id="opt-code" ${this._options.includeCodeBlocks ? 'checked' : ''}>
        Code snippets
      </label>
      <label title="Redact secrets such as API keys and tokens">
        <input type="checkbox" id="opt-redact" ${this._options.redactSecrets ? 'checked' : ''}>
        &#x1F512; Redact secrets
      </label>
    </div>
    <button class="btn btn-secondary" id="btn-regen" title="Re-run the summary with current options">&#x21BB; Refresh</button>
    <button class="btn" id="btn-copy" title="Copy summary as Markdown">&#x1F4CB; Copy Markdown</button>
    <button class="btn btn-secondary" id="btn-save" title="Save summary to a .md file">&#x1F4BE; Save&hellip;</button>
    <button class="btn btn-secondary" id="btn-export-full" title="Open the full session export dialog">&#x1F4E4; Full export&hellip;</button>
  </div>
  ${!this._options.redactSecrets ? '<div class="warning-bar">&#x26A0;&#xFE0F; Secret redaction is OFF &mdash; review before sharing.</div>' : ''}
  <div id="scroll-area">
    ${isLoading
      ? `<div style="display:flex;align-items:center;justify-content:center;gap:14px;padding:60px 0;opacity:0.75">
      <style>
        @keyframes csb-spin { to { transform: rotate(360deg); } }
        .csb-spinner { width: 20px; height: 20px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: csb-spin 0.75s linear infinite; flex-shrink: 0; }
      </style>
      <div class="csb-spinner"></div>
      <span style="font-size:13px">Generating summary with Copilot&hellip;</span>
    </div>`
      : `<div class="md">${renderedHtml}</div>`
    }
  </div>

  <script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('btn-copy').addEventListener('click', () => vscode.postMessage({ type: 'copyMarkdown' }));
  document.getElementById('btn-save').addEventListener('click', () => vscode.postMessage({ type: 'saveMarkdown' }));
  document.getElementById('btn-export-full').addEventListener('click', () => vscode.postMessage({ type: 'exportFull' }));
  document.getElementById('btn-regen').addEventListener('click', () => {
    vscode.postMessage({
      type: 'regenerate',
      includeCodeBlocks: document.getElementById('opt-code').checked,
      redactSecrets: document.getElementById('opt-redact').checked,
    });
  });
  </script>
</body>
</html>`;
  }
}
