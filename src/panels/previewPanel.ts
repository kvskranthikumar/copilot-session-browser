import * as vscode from 'vscode';
import { SessionWithMessages, ExportFormat, ExportOptions } from '../models/types';
import { ExporterService } from '../services/exporterService';

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

const exporter = new ExporterService();

/** Webview panel that previews generated export content (Markdown / JIRA / JSON)
 *  with buttons to copy to clipboard or save to file. */
export class PreviewPanel {
  public static readonly viewType = 'copilotSessionBrowser.preview';

  private static _panels = new Map<string, PreviewPanel>();

  public static openOrReveal(
    session: SessionWithMessages,
    options: ExportOptions,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.Two,
  ): PreviewPanel {
    const key = `${session.id}-${options.format}`;
    const existing = PreviewPanel._panels.get(key);
    if (existing) {
      existing._options = options;
      existing._refresh();
      existing._panel.reveal(column);
      return existing;
    }
    const formatLabel = options.format === 'json' ? 'JSON' : 'Markdown';
    const panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      `Preview: ${session.title.slice(0, 30)} [${formatLabel}]`,
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return new PreviewPanel(panel, session, options, key);
  }

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _options: ExportOptions;
  private _content: string;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly session: SessionWithMessages,
    options: ExportOptions,
    key: string,
  ) {
    this._panel = panel;
    this._options = options;
    this._content = exporter.export(session, options);
    PreviewPanel._panels.set(key, this);

    this._panel.webview.html = this._buildHtml();

    this._panel.onDidDispose(
      () => {
        PreviewPanel._panels.delete(key);
        this._disposables.forEach(d => d.dispose());
      },
      null,
      this._disposables,
    );

    this._panel.webview.onDidReceiveMessage(
      async msg => {
        switch (msg.type) {
          case 'copy':
            await vscode.env.clipboard.writeText(this._content);
            void vscode.window.showInformationMessage('Copied to clipboard!');
            break;

          case 'save': {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(
                exporter.defaultFilename(session, this._options.format),
              ),
              filters:
                this._options.format === 'json'
                  ? { JSON: ['json'] }
                  : { Markdown: ['md'] },
              title: 'Save file',
            });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(this._content, 'utf-8'));
              void vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
            }
            break;
          }

          case 'regenerate': {
            this._options = {
              ...this._options,
              includeCodeBlocks: msg.includeCodeBlocks as boolean,
              redactSecrets: msg.redactSecrets as boolean,
            };
            this._refresh();
            break;
          }
        }
      },
      null,
      this._disposables,
    );
  }

  private _refresh(): void {
    this._content = exporter.export(this.session, this._options);
    this._panel.webview.html = this._buildHtml();
  }

  private _buildHtml(): string {
    const nonce = getNonce();
    const webview = this._panel.webview;
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const isJson = this._options.format === 'json';
    const formatLabel = isJson ? 'JSON' : 'Markdown';
    const escaped = escHtml(this._content);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Preview — ${escHtml(formatLabel)}</title>
  <style>
    :root {
      --fg: var(--vscode-editor-foreground);
      --bg: var(--vscode-editor-background);
      --border: var(--vscode-panel-border, #444);
      --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
      --header-bg: var(--vscode-sideBarSectionHeader-background);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .header {
      flex-shrink: 0;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      padding: 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .header h2 { font-size: 14px; }
    .meta { font-size: 11px; opacity: 0.6; }
    .options { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .options label { display: flex; gap: 6px; align-items: center; font-size: 12px; cursor: pointer; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 2px;
      padding: 5px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover { opacity: 0.85; }
    .btn-secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .hint {
      flex-shrink: 0;
      font-size: 11px;
      opacity: 0.6;
      padding: 4px 16px;
      border-bottom: 1px solid var(--border);
    }
    .warning {
      flex-shrink: 0;
      background: var(--vscode-inputValidation-warningBackground, #3d2e00);
      border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      color: var(--fg);
      padding: 5px 16px;
      font-size: 11px;
    }
    textarea {
      flex: 1;
      min-height: 0;
      background: var(--code-bg);
      color: var(--fg);
      border: none;
      padding: 16px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.95em;
      line-height: 1.6;
      resize: none;
      outline: none;
      tab-size: 2;
    }
    .line-count {
      flex-shrink: 0;
      padding: 3px 16px;
      font-size: 11px;
      opacity: 0.5;
      border-top: 1px solid var(--border);
      text-align: right;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>📄 ${escHtml(formatLabel)} Preview — ${escHtml(this.session.title.slice(0, 50))}</h2>
    <div class="meta">${this.session.messageCount} message${this.session.messageCount !== 1 ? 's' : ''} · ${escHtml(this.session.updatedAt.toLocaleDateString())}</div>
    ${!isJson ? `<div class="options">
      <label><input type="checkbox" id="opt-code" ${this._options.includeCodeBlocks ? 'checked' : ''}>Include code blocks</label>
      <label><input type="checkbox" id="opt-redact" ${this._options.redactSecrets ? 'checked' : ''}>Redact secrets</label>
      <button class="btn btn-secondary" id="btn-regen">↻ Regenerate</button>
    </div>` : ''}
    <div class="actions">
      <button class="btn" id="btn-copy">📋 Copy to clipboard</button>
      <button class="btn btn-secondary" id="btn-save">💾 Save to file…</button>
    </div>
  </div>
  <div class="hint">Read-only preview · ${escHtml(formatLabel)} · ${this._content.split('\n').length} lines</div>
  ${!this._options.redactSecrets && !isJson ? '<div class="warning">⚠️ Secret redaction is disabled — review before sharing.</div>' : ''}
  <textarea id="preview" aria-label="${escHtml(formatLabel)} preview" spellcheck="false" readonly>${escaped}</textarea>
  <div class="line-count" id="line-count">${this._content.split('\n').length} lines · ${this._content.length} chars</div>

  <script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  document.getElementById('btn-copy').addEventListener('click', () => {
    vscode.postMessage({ type: 'copy' });
  });
  document.getElementById('btn-save').addEventListener('click', () => {
    vscode.postMessage({ type: 'save' });
  });
  ${!isJson ? `
  document.getElementById('btn-regen').addEventListener('click', () => {
    vscode.postMessage({
      type: 'regenerate',
      includeCodeBlocks: document.getElementById('opt-code').checked,
      redactSecrets: document.getElementById('opt-redact').checked,
    });
  });` : ''}
  </script>
</body>
</html>`;
  }
}
