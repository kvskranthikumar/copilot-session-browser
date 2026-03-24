import * as vscode from 'vscode';
import { DiscoveryService } from './services/discoveryService';
import { ParserService } from './services/parserService';
import { IndexService } from './services/indexService';
import { ExporterService } from './services/exporterService';
import { SessionListProvider } from './providers/sessionListProvider';
import { TranscriptPanel } from './panels/transcriptPanel';
import { SummaryPanel } from './panels/summaryPanel';
import { PreviewPanel } from './panels/previewPanel';
import { DiagnosticsPanel } from './panels/diagnosticsPanel';
import { ExportFormat, SummaryOptions } from './models/types';

// ── Singletons ────────────────────────────────────────────────────────────────

const index = new IndexService();
const parser = new ParserService();
const exporter = new ExporterService();
let discovery: DiscoveryService;
let listProvider: SessionListProvider;

// ── Activation ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  SessionListProvider.initOutput();

  const cfg = vscode.workspace.getConfiguration('copilotSessionBrowser');
  const extraPaths = cfg.get<string[]>('additionalSearchPaths', []);
  const overridePath = cfg.get<string>('overrideStoragePath', '');

  discovery = new DiscoveryService(extraPaths, overridePath, context.extensionPath);
  listProvider = new SessionListProvider(context.extensionUri, index);

  // Inject a SYNCHRONOUS workspace scanner — discovery uses sync file I/O
  // so this is safe to call from the webview's ready handler without any
  // async timing issues.
  listProvider.setWorkspaceScanner(() => discovery.listWorkspaceFoldersSync());

  // Register the sidebar webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionListProvider.viewType,
      listProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Register all commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotSessionBrowser.refresh', () =>
      cmdRefresh(context)),

    vscode.commands.registerCommand(
      'copilotSessionBrowser.viewSession',
      (sessionId?: string) => cmdViewSession(sessionId, context),
    ),

    vscode.commands.registerCommand(
      'copilotSessionBrowser.summarize',
      (sessionId?: string) => cmdSummarize(sessionId, context),
    ),

    vscode.commands.registerCommand(
      'copilotSessionBrowser.exportSession',
      (sessionId?: string, roleFilter?: string) => cmdExport(sessionId, context, roleFilter),
    ),

    vscode.commands.registerCommand('copilotSessionBrowser.importSession', () =>
      cmdImport()),

    vscode.commands.registerCommand('copilotSessionBrowser.diagnostics', () =>
      cmdDiagnostics(context)),

    vscode.commands.registerCommand('copilotSessionBrowser.setStoragePath', () =>
      cmdSetStoragePath(context)),
  );

  // Auto-refresh on activation (non-blocking)
  void cmdRefresh(context);
}

export function deactivate(): void {
  // Nothing to clean up
}

// ── Command implementations ───────────────────────────────────────────────────

async function cmdRefresh(context: vscode.ExtensionContext): Promise<void> {
  SessionListProvider.log('cmdRefresh: START');
  listProvider.setStatusMessage('Refreshing…');

  const cfg = vscode.workspace.getConfiguration('copilotSessionBrowser');
  const extraPaths = cfg.get<string[]>('additionalSearchPaths', []);
  const overridePath = cfg.get<string>('overrideStoragePath', '');
  SessionListProvider.log(`cmdRefresh: overridePath="${overridePath}" extraPaths=${JSON.stringify(extraPaths)}`);
  discovery = new DiscoveryService(extraPaths, overridePath, context.extensionPath);

  try {
    SessionListProvider.log('cmdRefresh: calling discoverSessionFiles()…');
    const results = await discovery.discoverSessionFiles();
    SessionListProvider.log(`cmdRefresh: discoverSessionFiles() returned ${results.length} results`);

    // Log every discovered file
    for (const r of results) {
      SessionListProvider.log(
        `  DISCOVERED: type=${r.type} sessions=${r.sessionCount} hash=${r.workspaceHash ?? '-'} schema=${r.schemaVersion} path=${r.path}` +
        (r.errors.length > 0 ? ` ERRORS=[${r.errors.join('; ')}]` : ''),
      );
    }

    index.clear();
    let totalAdded = 0;

    for (const result of results) {
      let sessions: import('./models/types').SessionWithMessages[] = [];

      if (result.type === 'json') {
        const parsed = parser.parseFile(result.path);
        sessions = parsed.sessions;
        SessionListProvider.log(`  PARSE JSON: ${result.path} → ${sessions.length} sessions, schema=${parsed.schemaVersion}`);
        if (parsed.errors.length > 0) {
          SessionListProvider.log(`  PARSE ERRORS: ${parsed.errors.join('; ')}`);
          console.warn(`[CopilotSessionBrowser] Parser errors in ${result.path}:`, parsed.errors);
        }
      } else if (result.type === 'sqlite') {
        if (result.sessionCount > 0) {
          const sqliteReader = discovery.getSqliteReader();
          if (sqliteReader) {
            try {
              const res = await sqliteReader.readSessions(result.path);
              sessions = res.sessions;
              SessionListProvider.log(
                `  PARSE SQLITE: ${result.path} → ${sessions.length} sessions, schema=${res.schemaUsed}` +
                (res.errors.length > 0 ? ` ERRORS=[${res.errors.join('; ')}]` : ''),
              );
            } catch (err) {
              SessionListProvider.log(`  PARSE SQLITE ERROR: ${result.path} → ${err instanceof Error ? err.message : String(err)}`);
              console.warn(`[CopilotSessionBrowser] SQLite read error in ${result.path}:`, err);
            }
          } else {
            SessionListProvider.log(`  PARSE SQLITE SKIP: no sqliteReader available for ${result.path}`);
          }
        } else {
          SessionListProvider.log(`  SKIP SQLITE: sessionCount=0 for ${result.path}`);
        }
      }

      // Apply workspaceHash as a fallback label for sessions without a context
      if (result.workspaceHash) {
        for (const s of sessions) {
          if (!s.workspaceContext) {
            s.workspaceContext = result.workspaceHash;
          }
        }
      }

      // Log workspace context for each session
      for (const s of sessions) {
        SessionListProvider.log(`    SESSION: id=${s.id.substring(0, 8)} title="${s.title.substring(0, 40)}" ws="${(s.workspaceContext ?? '').substring(0, 60)}" msgs=${s.messageCount}`);
      }

      // Drop sessions with no messages — these are empty/archived chats that
      // VS Code created automatically but the user never interacted with.
      const activeSessions = sessions.filter(s => s.messageCount > 0);
      if (activeSessions.length > 0) {
        const { added } = index.upsertAll(activeSessions);
        totalAdded += added;
      }
    }

    // Restore any previously imported sessions from extension storage
    const imported = context.globalState.get<string>('importedSessions');
    if (imported) {
      const parsed = parser.parseRaw(imported, 'imported');
      if (parsed.sessions.length > 0) {
        index.upsertAll(parsed.sessions);
        totalAdded += parsed.sessions.length;
        SessionListProvider.log(`cmdRefresh: imported sessions added: ${parsed.sessions.length}`);
      }
    }

    SessionListProvider.log(`cmdRefresh: totalAdded=${totalAdded} index.count()=${index.count()}`);
    listProvider.setStatusMessage(
      `${index.count()} session${index.count() !== 1 ? 's' : ''} loaded`,
    );

    // Fetch workspace folders and send everything to the webview together
    const workspaceFolders = await discovery.listWorkspaceFolders();
    SessionListProvider.log(`cmdRefresh: workspaceFolders=${workspaceFolders.length}`);
    listProvider.setDiscoveredWorkspaces(workspaceFolders);
    listProvider.refresh();

    if (index.count() === 0) {
      SessionListProvider.log('cmdRefresh: 0 sessions — showing help message');
      listProvider.setStatusMessage('No sessions found — try Import or Diagnostics');
    }
    SessionListProvider.log('cmdRefresh: DONE');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    SessionListProvider.log(`cmdRefresh: ERROR: ${msg}`);
    listProvider.setStatusMessage(`Error: ${msg}`);
    vscode.window.showErrorMessage(`Copilot Session Browser: ${msg}`);
  }
}

async function cmdViewSession(
  sessionId: string | undefined,
  context: vscode.ExtensionContext,
): Promise<void> {
  const id = sessionId ?? await promptSelectSession();
  if (!id) {
    return;
  }

  const session = index.getById(id);
  if (!session) {
    void vscode.window.showErrorMessage(`Session not found: ${id}`);
    return;
  }

  SessionListProvider.log(
    `cmdViewSession: id=${id.substring(0, 12)} title="${session.title.substring(0, 50)}" msgs=${session.messageCount} schema=${session.schemaVersion}`,
  );

  TranscriptPanel.openOrReveal(session, context.extensionUri, vscode.ViewColumn.One);
}

async function cmdSummarize(
  sessionId: string | undefined,
  context: vscode.ExtensionContext,
): Promise<void> {
  const id = sessionId ?? await promptSelectSession();
  if (!id) {
    return;
  }

  const session = index.getById(id);
  if (!session) {
    void vscode.window.showErrorMessage(`Session not found: ${id}`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration('copilotSessionBrowser');
  const redactByDefault = cfg.get<boolean>('redactSecretsByDefault', true);

  const options: SummaryOptions = {
    includeCodeBlocks: true,
    redactSecrets: redactByDefault,
  };

  SummaryPanel.openOrReveal(
    session,
    options,
    context.extensionUri,
    vscode.ViewColumn.Two,
  );
}

async function cmdExport(sessionId: string | undefined, context: vscode.ExtensionContext, roleFilter?: string): Promise<void> {
  const id = sessionId ?? await promptSelectSession();
  if (!id) {
    return;
  }

  const session = index.getById(id);
  if (!session) {
    void vscode.window.showErrorMessage(`Session not found: ${id}`);
    return;
  }

  // Pick format
  const formatPick = await vscode.window.showQuickPick(
    [
      { label: '$(markdown) Standard Markdown', description: 'Full transcript as Markdown', value: 'markdown' as ExportFormat },
      { label: '$(json) JSON', description: 'Full session as normalized JSON (re-importable)', value: 'json' as ExportFormat },
    ],
    { title: 'Select export format', placeHolder: 'Choose format…' },
  );
  if (!formatPick) {
    return;
  }

  // Redaction + code block options (skip for JSON)
  const cfg = vscode.workspace.getConfiguration('copilotSessionBrowser');
  const redactByDefault = cfg.get<boolean>('redactSecretsByDefault', true);

  let redactSecrets = redactByDefault;
  let includeCodeBlocks = true;

  if (formatPick.value !== 'json') {
    const redactPick = await vscode.window.showQuickPick(
      [
        { label: '$(shield) Redact secrets (recommended)', value: true },
        { label: '$(warning) Include secrets as-is', value: false },
      ],
      { title: 'Secret redaction', placeHolder: `Default: ${redactByDefault ? 'ON' : 'OFF'}` },
    );
    redactSecrets = redactPick?.value ?? redactByDefault;

    const codeBlocksPick = await vscode.window.showQuickPick(
      [
        { label: '$(code) Include code blocks', value: true },
        { label: '$(circle-slash) Exclude code blocks', value: false },
      ],
      { title: 'Code blocks', placeHolder: 'Choose…' },
    );
    includeCodeBlocks = codeBlocksPick?.value ?? true;
  }

  // Open preview panel — user can copy or save from there
  const resolvedRoleFilter = (roleFilter === 'user' || roleFilter === 'assistant') ? roleFilter : 'all';
  PreviewPanel.openOrReveal(
    session,
    { format: formatPick.value, includeCodeBlocks, includeFilePaths: false, redactSecrets, roleFilter: resolvedRoleFilter },
    context.extensionUri,
    vscode.ViewColumn.Two,
  );
}

async function cmdImport(): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    title: 'Import Copilot Session File',
    canSelectMany: true,
    filters: {
      'Session files': ['json', 'md'],
      'JSON': ['json'],
    },
  });

  if (!uris || uris.length === 0) {
    return;
  }

  let totalImported = 0;
  const errors: string[] = [];

  for (const uri of uris) {
    const filePath = uri.fsPath;
    const parsed = parser.parseImportedFile(filePath);
    if (parsed.sessions.length > 0) {
      index.upsertAll(parsed.sessions);
      totalImported += parsed.sessions.length;
    }
    if (parsed.errors.length > 0) {
      errors.push(`${filePath}: ${parsed.errors.join('; ')}`);
    }
  }

  listProvider.refresh();

  if (totalImported > 0) {
    void vscode.window.showInformationMessage(
      `Imported ${totalImported} session${totalImported !== 1 ? 's' : ''}.`,
    );
  }

  if (errors.length > 0) {
    void vscode.window.showWarningMessage(
      `Import warnings: ${errors.join('\n')}`,
    );
  }

  if (totalImported === 0 && errors.length === 0) {
    void vscode.window.showWarningMessage(
      'No sessions found in the selected file(s). ' +
        'Make sure the file is a valid exported session (JSON schema v1–v4).',
    );
  }
}

async function cmdDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  listProvider.setStatusMessage('Running diagnostics…');
  try {
    const diagnostics = await discovery.getDiagnosticsInfo();
    DiagnosticsPanel.openOrReveal(diagnostics, context.extensionUri, vscode.ViewColumn.One);
    listProvider.setStatusMessage(`${index.count()} session(s) loaded`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Diagnostics failed: ${msg}`);
    listProvider.setStatusMessage('Diagnostics error');
  }
}

async function cmdSetStoragePath(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('copilotSessionBrowser');
  const current = cfg.get<string>('overrideStoragePath', '');

  const input = await vscode.window.showInputBox({
    title: 'Set Storage Path Override',
    prompt:
      'Enter the path to scan for Copilot Chat sessions. ' +
      'Accepts: a VS Code User directory, a workspaceStorage folder, or a globalStorage folder. ' +
      'Leave blank to use auto-detection.',
    value: current,
    placeHolder: 'e.g. C:\\Users\\you\\AppData\\Roaming\\Code\\User\\workspaceStorage',
    ignoreFocusOut: true,
  });

  if (input === undefined) {
    // User cancelled
    return;
  }

  await cfg.update('overrideStoragePath', input.trim(), vscode.ConfigurationTarget.Global);

  if (input.trim()) {
    void vscode.window.showInformationMessage(
      `Storage path set to: ${input.trim()}. Refreshing…`,
    );
  } else {
    void vscode.window.showInformationMessage(
      'Storage path override cleared. Using auto-detection. Refreshing…',
    );
  }

  void cmdRefresh(context);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function promptSelectSession(): Promise<string | undefined> {
  const sessions = index.query({}, 'updatedAt', 'desc');
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('No sessions loaded. Try refreshing.');
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    sessions.map(s => ({
      label: s.title,
      description: `${s.messageCount} messages · ${s.updatedAt.toLocaleDateString()}`,
      value: s.id,
    })),
    { title: 'Select a session', placeHolder: 'Type to filter…' },
  );

  return pick?.value;
}
