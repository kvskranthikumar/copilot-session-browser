import * as vscode from 'vscode';
import { SessionWithMessages } from '../models/types';
import { renderMarkdown } from '../utils/markdownRenderer';

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

function formatDateFull(d: Date | undefined): string {
  if (!d) {
    return '';
  }
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export class TranscriptPanel {
  public static readonly viewType = 'copilotSessionBrowser.transcript';

  public static openOrReveal(
    session: SessionWithMessages,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.One,
  ): TranscriptPanel {
    const existing = TranscriptPanel._panels.get(session.id);
    if (existing) {
      // Always refresh the content in case the session was re-loaded with new data
      existing._panel.reveal(column);
      existing._panel.webview.html = existing._buildHtml();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      TranscriptPanel.viewType,
      session.title.slice(0, 40),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    const instance = new TranscriptPanel(panel, session, extensionUri);
    return instance;
  }

  private static _panels = new Map<string, TranscriptPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly session: SessionWithMessages,
    private readonly extensionUri: vscode.Uri,
  ) {
    this._panel = panel;
    TranscriptPanel._panels.set(session.id, this);

    this._panel.webview.html = this._buildHtml();

    this._panel.onDidDispose(
      () => {
        TranscriptPanel._panels.delete(session.id);
        this._disposables.forEach(d => d.dispose());
      },
      null,
      this._disposables,
    );

    this._panel.webview.onDidReceiveMessage(
      msg => {
        switch (msg.type) {
          case 'copyCode':
            void vscode.env.clipboard.writeText(msg.code as string);
            void vscode.window.showInformationMessage('Code copied to clipboard.');
            break;
          case 'summarize':
            void vscode.commands.executeCommand(
              'copilotSessionBrowser.summarize',
              session.id,
            );
            break;
          case 'exportSession':
            void vscode.commands.executeCommand(
              'copilotSessionBrowser.exportSession',
              session.id,
            );
            break;
        }
      },
      null,
      this._disposables,
    );
  }

  private _buildHtml(): string {
    const nonce = getNonce();
    const webview = this._panel.webview;
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    // For V5 sessions (VS Code Copilot Chat), the full transcript is not stored
    // in the DB — only metadata. If we only have the synthetic title message,
    // show an informational banner instead of misleading content.
    const isV5Limited = this.session.schemaVersion === 'v5'
      && this.session.messages.length === 1
      && this.session.messages[0].id.endsWith('-title');

    // Collect all code blocks (referenced by index for copy)
    const codeBlockData: { language: string; content: string }[] = [];
    const messagesHtml = this.session.messages.map((msg, msgIdx) => this._renderMessage(msg, msgIdx, codeBlockData)).join('\n');

    // Escape </ so that code block content containing </script> (or any </tag>)
    // cannot prematurely close the <script> block in the HTML parser.
    const codeBlocksJson = JSON.stringify(codeBlockData.map(cb => cb.content))
      .replace(/<\//g, '<\\/');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escHtml(this.session.title)}</title>
  <style>
    :root {
      --user-bg: var(--vscode-inputValidation-infoBackground, #1a3a5c);
      --asst-bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #444);
      --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
      --code-fg: var(--vscode-editor-foreground);
      --accent: var(--vscode-focusBorder);
      --header-bg: var(--vscode-sideBarSectionHeader-background, #2d2d2d);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --radius: 6px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      line-height: 1.6;
    }
    .session-header {
      flex: 0 0 auto;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px 8px;
    }
    #scroll-area {
      flex: 1;
      overflow-y: auto;
      padding: 0 16px 48px;
    }
    .session-header h1 {
      font-size: 16px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-meta {
      font-size: 11px;
      opacity: 0.7;
      margin-top: 4px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .session-actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 2px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover { opacity: 0.85; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--fg));
      border: 1px solid var(--border);
    }

    /* Messages */
    .message {
      margin: 16px 0;
      border-radius: var(--radius);
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .message.user { border-left: 4px solid var(--vscode-terminal-ansiBlue, #4e9fd5); }
    .message.assistant { border-left: 4px solid var(--vscode-terminal-ansiGreen, #4ec94e); }
    .message.system { border-left: 4px solid var(--vscode-terminal-ansiYellow, #cca700); }

    .msg-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--header-bg);
      cursor: pointer;
      user-select: none;
    }
    .msg-header:hover { opacity: 0.9; }
    .role-badge {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .msg-timestamp { font-size: 11px; opacity: 0.6; margin-left: auto; }
    .collapse-btn {
      background: transparent;
      border: none;
      color: var(--fg);
      cursor: pointer;
      font-size: 12px;
      padding: 0 4px;
      opacity: 0.7;
      transition: transform 0.15s;
    }
    .msg-body {
      padding: 12px 16px;
    }
    .message.collapsed .msg-body { display: none; }
    .message.collapsed .collapse-btn { transform: rotate(-90deg); }

    /* Markdown content */
    .msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4 {
      margin: 12px 0 6px;
      font-weight: 600;
    }
    .msg-body h1 { font-size: 1.4em; }
    .msg-body h2 { font-size: 1.2em; }
    .msg-body h3 { font-size: 1.1em; }
    .msg-body p { margin: 6px 0; }
    .msg-body ul, .msg-body ol { margin: 6px 0 6px 20px; }
    .msg-body li { margin: 3px 0; }
    .msg-body code {
      background: var(--code-bg);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }
    .msg-body blockquote {
      border-left: 3px solid var(--border);
      margin: 6px 0;
      padding-left: 12px;
      opacity: 0.8;
    }
    .msg-body hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
    .msg-body .md-link { color: var(--vscode-textLink-foreground, #4e9fd5); text-decoration: underline; cursor: default; }
    .msg-body .task-item { list-style: none; margin-left: -4px; }
    .msg-body .task-item.checked { opacity: 0.7; }

    /* Code blocks */
    .code-block {
      margin: 10px 0;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      background: var(--code-bg);
      border-bottom: 1px solid var(--border);
      opacity: 0.9;
    }
    .code-lang { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); }
    .copy-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 3px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 11px;
    }
    .copy-btn:hover { background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.1)); }
    .copy-btn.copied { color: var(--vscode-terminal-ansiGreen, #4ec94e); }
    .code-block pre {
      background: var(--code-bg);
      padding: 10px 12px;
      overflow-x: auto;
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      line-height: 1.5;
    }
    .code-block code { background: transparent; padding: 0; }
  </style>
</head>
<body>

<div class="session-header">
  <h1 title="${escHtml(this.session.title)}">${escHtml(this.session.title)}</h1>
  <div class="session-meta">
    ${this.session.workspaceContext ? `<span>📁 ${escHtml(this.session.workspaceContext)}</span>` : ''}
    <span>🕐 ${escHtml(formatDateFull(this.session.createdAt))}</span>
    <span>💬 Session ID: ${escHtml(this.session.id.substring(0, 16))}…</span>
    ${this.session.tags.length ? `<span>🏷 ${this.session.tags.map(t => escHtml(t)).join(', ')}</span>` : ''}
  </div>
  <div class="session-actions">
    <button class="btn" id="btn-sum">📋 Summarize</button>
    <button class="btn btn-secondary" id="btn-export">💾 Export…</button>
    <button class="btn btn-secondary" id="btn-toggle-all" data-collapsed="false">Collapse all</button>
  </div>
</div>

<div id="scroll-area">
${isV5Limited ? `<div style="margin:12px 0;padding:10px 14px;border-radius:6px;border:1px solid var(--vscode-panel-border,#444);background:var(--vscode-editor-infoBackground,rgba(0,122,204,0.08));font-size:12px;line-height:1.6;color:var(--vscode-descriptionForeground)">
  ℹ️ <strong>Transcript not stored on disk (V5 format)</strong><br>
  VS Code Copilot Chat does not persist the full conversation to the local database. Only the session title and timing are available.
  The first message below is reconstructed from the session title.
</div>` : ''}

<div id="transcript">
${messagesHtml}
</div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const CODES = ${codeBlocksJson};

document.getElementById('btn-sum').addEventListener('click', () => vscode.postMessage({ type: 'summarize' }));
document.getElementById('btn-export').addEventListener('click', () => vscode.postMessage({ type: 'exportSession' }));
document.getElementById('btn-toggle-all').addEventListener('click', function() {
  const collapsed = this.dataset.collapsed === 'true';
  document.querySelectorAll('.message').forEach(m =>
    collapsed ? m.classList.remove('collapsed') : m.classList.add('collapsed')
  );
  this.dataset.collapsed = collapsed ? 'false' : 'true';
  this.textContent = collapsed ? 'Collapse all' : 'Expand all';
});

// Collapse/expand on header click
document.querySelectorAll('.msg-header').forEach(header => {
  header.addEventListener('click', () => header.closest('.message').classList.toggle('collapsed'));
  header.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      header.closest('.message').classList.toggle('collapsed');
      e.preventDefault();
    }
  });
});

// Copy buttons
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const idx = parseInt(btn.dataset.idx, 10);
    const code = CODES[idx] || '';
    vscode.postMessage({ type: 'copyCode', code });
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
});

// Keyboard navigation between messages
document.querySelectorAll('.message').forEach((msg, idx) => {
  msg.setAttribute('tabindex', '0');
  msg.addEventListener('keydown', e => {
    const msgs = [...document.querySelectorAll('.message')];
    if (e.key === 'ArrowDown') { msgs[Math.min(idx + 1, msgs.length - 1)].focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { msgs[Math.max(idx - 1, 0)].focus(); e.preventDefault(); }
  });
});
</script>
</body>
</html>`;
  }

  private _renderMessage(
    msg: SessionWithMessages['messages'][number],
    _msgIdx: number,
    codeBlockSink: { language: string; content: string }[],
  ): string {
    const roleLabel =
      msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Copilot' : 'System';
    const ts = msg.timestamp ? formatDateFull(msg.timestamp) : '';

    const bodyHtml = renderMarkdown(msg.markdownContent, codeBlockSink);

    return /* html */ `
<div class="message ${escHtml(msg.role)}" role="article" aria-label="${roleLabel} message">
  <div class="msg-header" role="button" tabindex="0" aria-expanded="true" aria-label="Toggle ${roleLabel} message">
    <span class="role-badge">${escHtml(roleLabel)}</span>
    ${ts ? `<span class="msg-timestamp">${escHtml(ts)}</span>` : ''}
    <button class="collapse-btn" aria-label="Collapse" tabindex="-1">▾</button>
  </div>
  <div class="msg-body">${bodyHtml}</div>
</div>`;
  }
}
