import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DiscoveryResult, DiagnosticsInfo, SearchPath, WorkspaceInfo } from '../models/types';
import { SqliteReaderService } from './sqliteReaderService';

const COPILOT_CHAT_EXTENSION_ID = 'github.copilot-chat';

/**
 * Returns candidate VS Code user-data directories for all known VS Code variants
 * (Stable, Insiders, OSS) on the current OS, without hardcoding absolute paths.
 */
function getVSCodeUserDataPaths(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(
      path.join(appData, 'Code', 'User'),
      path.join(appData, 'Code - Insiders', 'User'),
      path.join(appData, 'Code - OSS', 'User'),
      path.join(appData, 'VSCodium', 'User'),
    );
  } else if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    candidates.push(
      path.join(appSupport, 'Code', 'User'),
      path.join(appSupport, 'Code - Insiders', 'User'),
      path.join(appSupport, 'VSCodium', 'User'),
    );
  } else {
    // Linux / other POSIX
    const configBase =
      process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(
      path.join(configBase, 'Code', 'User'),
      path.join(configBase, 'Code - Insiders', 'User'),
      path.join(configBase, 'VSCodium', 'User'),
      // VS Code Server (Remote - SSH / vscode-server) stores data here, not in
      // the XDG config directory used by the desktop application.
      path.join(home, '.vscode-server', 'data', 'User'),
      path.join(home, '.vscode-server-insiders', 'data', 'User'),
    );
  }

  return candidates;
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export class DiscoveryService {
  private extraPaths: string[];
  private overridePath: string;
  private sqliteReader: SqliteReaderService | null;

  constructor(extraPaths: string[] = [], overridePath = '', extensionPath?: string) {
    this.extraPaths = extraPaths;
    this.overridePath = overridePath.trim();
    this.sqliteReader = extensionPath ? new SqliteReaderService(extensionPath) : null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async discoverSessionFiles(): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];

    if (this.overridePath) {
      await this.scanByOverridePath(this.overridePath, results);
      return results;
    }

    const vsDataPaths = getVSCodeUserDataPaths();
    for (const dataPath of [...vsDataPaths, ...this.extraPaths]) {
      if (!safeExists(dataPath)) {
        continue;
      }
      await this.scanGlobalStorage(dataPath, results);
      await this.scanWorkspaceStorage(dataPath, results);
    }

    return results;
  }

  async getDiagnosticsInfo(): Promise<DiagnosticsInfo> {
    const vsDataPaths = getVSCodeUserDataPaths();
    const searchPaths: SearchPath[] = [];
    const errors: string[] = [];

    if (this.overridePath) {
      searchPaths.push({
        path: `[OVERRIDE] ${this.overridePath}`,
        exists: safeExists(this.overridePath),
      });
    }

    for (const dataPath of this.overridePath ? [] : [...vsDataPaths, ...this.extraPaths]) {
      const globalStorage = path.join(
        dataPath,
        'globalStorage',
        COPILOT_CHAT_EXTENSION_ID,
      );
      const wsStorage = path.join(dataPath, 'workspaceStorage');

      const globalExists = safeExists(globalStorage);
      const files = globalExists
        ? safeReaddir(globalStorage).slice(0, 50)
        : undefined;

      searchPaths.push({
        path: globalStorage,
        exists: globalExists,
        fileCount: files?.length,
        files,
      });

      searchPaths.push({
        path: wsStorage + ' (all workspace sub-dirs)',
        exists: safeExists(wsStorage),
      });
    }

    const discoveredFiles = await this.discoverSessionFiles();
    const totalSessionsLoaded = discoveredFiles
      .filter(r => r.type === 'json')
      .reduce((s, r) => s + r.sessionCount, 0);

    return {
      osType: process.platform,
      vsCodeDataPaths: vsDataPaths,
      searchPaths,
      discoveredFiles,
      totalSessionsLoaded,
      errors,
      timestamp: new Date(),
    };
  }
  getSqliteReader(): SqliteReaderService | null {
    return this.sqliteReader;
  }

  /** Returns all workspace hash folders under workspaceStorage, with labels from workspace.json. */
  async listWorkspaceFolders(): Promise<WorkspaceInfo[]> {
    return this.listWorkspaceFoldersSync();
  }

  /**
   * Synchronous version — all I/O is already synchronous (readFileSync, readdirSync),
   * so this is safe to call from non-async contexts.
   */
  listWorkspaceFoldersSync(): WorkspaceInfo[] {
    const roots: string[] = [];

    if (this.overridePath) {
      const base = path.basename(this.overridePath).toLowerCase();
      if (base === 'workspacestorage') {
        roots.push(this.overridePath);
      }
      // If override is a User dir, check workspaceStorage underneath it
      const sub = path.join(this.overridePath, 'workspaceStorage');
      if (base !== 'workspacestorage' && safeExists(sub)) {
        roots.push(sub);
      }
    } else {
      for (const dp of [...getVSCodeUserDataPaths(), ...this.extraPaths]) {
        const wsRoot = path.join(dp, 'workspaceStorage');
        if (safeExists(wsRoot)) {
          roots.push(wsRoot);
        }
      }
    }

    const results: WorkspaceInfo[] = [];
    const seen = new Set<string>();

    for (const wsRoot of roots) {
      for (const entry of safeReaddir(wsRoot)) {
        if (seen.has(entry)) { continue; }
        const wsDir = path.join(wsRoot, entry);
        const stat = safeStat(wsDir);
        if (!stat?.isDirectory()) { continue; }
        seen.add(entry);

        const info: WorkspaceInfo = { hash: entry, label: entry.slice(0, 8), folderPath: '' };

        const wjPath = path.join(wsDir, 'workspace.json');
        if (safeExists(wjPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(wjPath, 'utf8')) as Record<string, unknown>;
            const raw = (data['folder'] as string | undefined) ?? (data['workspace'] as string | undefined) ?? '';
            if (raw) {
              const decoded = decodeURIComponent(
                raw.replace(/^file:\/\/\//, '/').replace(/^file:\/\//, ''),
              );
              info.folderPath = decoded;
              const parts = decoded.replace(/\\/g, '/').split('/').filter(Boolean);
              info.label = parts.pop() ?? info.label;
            }
          } catch { /* ignore */ }
        }

        results.push(info);
      }
    }

    results.sort((a, b) => {
      const aHasLabel = a.folderPath !== '';
      const bHasLabel = b.folderPath !== '';
      if (aHasLabel !== bHasLabel) { return aHasLabel ? -1 : 1; }
      return a.label.localeCompare(b.label);
    });

    return results;
  }
  // ── Private helpers ─────────────────────────────────────────────────────────

  private async scanGlobalStorage(
    dataPath: string,
    results: DiscoveryResult[],
  ): Promise<void> {
    const dir = path.join(dataPath, 'globalStorage', COPILOT_CHAT_EXTENSION_ID);
    await this.scanDirectory(dir, results);
  }

  private async scanWorkspaceStorage(
    dataPath: string,
    results: DiscoveryResult[],
  ): Promise<void> {
    const wsRoot = path.join(dataPath, 'workspaceStorage');
    await this.scanWorkspaceStorageRoot(wsRoot, results);
  }

  /** Scans a workspaceStorage directory directly (each sub-dir is a workspace hash). */
  private async scanWorkspaceStorageRoot(
    wsRoot: string,
    results: DiscoveryResult[],
  ): Promise<void> {
    if (!safeExists(wsRoot)) {
      return;
    }

    for (const entry of safeReaddir(wsRoot)) {
      const wsDir = path.join(wsRoot, entry);
      const stat = safeStat(wsDir);
      if (!stat?.isDirectory()) {
        continue;
      }

      // ── Modern Copilot Chat (>= 1.200): state.vscdb at workspace root ──────
      // When the workspace was used with Copilot Chat the extension creates a
      // "github.copilot-chat" (or "GitHub.copilot-chat") subdirectory.  The
      // actual session metadata lives in state.vscdb at the WORKSPACE level
      // (one directory above github.copilot-chat), NOT inside it.
      const copilotDirLower = safeReaddir(wsDir).find(
        n => n.toLowerCase() === COPILOT_CHAT_EXTENSION_ID.toLowerCase(),
      );
      if (copilotDirLower) {
        // Scan state.vscdb at workspace level — this is where sessions live
        const statDb = path.join(wsDir, 'state.vscdb');
        let statDbSessionCount = 0;
        if (safeExists(statDb)) {
          const statDbResult = await this.inspectSqliteFile(statDb);
          statDbResult.workspaceHash = entry;
          results.push(statDbResult);
          statDbSessionCount = statDbResult.sessionCount;
        }
        // Also scan inside github.copilot-chat/ for any legacy JSON files
        const copilotDir = path.join(wsDir, copilotDirLower);
        await this.scanDirectory(copilotDir, results, entry);

        // ── VS Code Server fallback: no state.vscdb, sessions in chatSessions/ ──
        // On vscode-server the workspace-level state.vscdb may not exist; sessions
        // are stored as JSONL files in GitHub.copilot-chat/chatSessions/.
        // Also check the hash-level chatSessions/ used by built-in Copilot in newer VS Code.
        if (statDbSessionCount === 0) {
          for (const chatDir of [
            path.join(copilotDir, 'chatSessions'),     // GitHub.copilot-chat/chatSessions/
            path.join(wsDir, 'chatSessions'),           // <hash>/chatSessions/ (built-in)
          ]) {
            if (safeExists(chatDir)) {
              const jsonlResult = await this.inspectJsonlDir(chatDir);
              if (jsonlResult.sessionCount > 0) {
                jsonlResult.workspaceHash = entry;
                results.push(jsonlResult);
                break;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Smart handler for the override path setting.
   * - Path whose basename is "workspaceStorage" → scan as a workspaceStorage root
   * - Path whose basename is "globalStorage"    → scan <path>/github.copilot-chat/
   * - Anything else                             → treat as VS Code User directory
   *                                               (scan both globalStorage and workspaceStorage)
   */
  private async scanByOverridePath(
    p: string,
    results: DiscoveryResult[],
  ): Promise<void> {
    const base = path.basename(p).toLowerCase();
    if (base === 'workspacestorage') {
      await this.scanWorkspaceStorageRoot(p, results);
    } else if (base === 'globalstorage') {
      await this.scanDirectory(path.join(p, COPILOT_CHAT_EXTENSION_ID), results);
    } else {
      // Treat as VS Code User directory
      await this.scanGlobalStorage(p, results);
      await this.scanWorkspaceStorage(p, results);
    }
  }

  private async scanDirectory(
    dir: string,
    results: DiscoveryResult[],
    workspaceHash?: string,
  ): Promise<void> {
    if (!safeExists(dir)) {
      return;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      const fullPath = path.join(dir, name);
      const stat = safeStat(fullPath);
      if (!stat?.isFile()) {
        continue;
      }

      if (name.endsWith('.json')) {
        const result = this.inspectJsonFile(fullPath);
        if (result) {
          result.workspaceHash = workspaceHash;
          results.push(result);
        }
      } else if (name.endsWith('.vscdb') || name.endsWith('.db')) {
        const result = await this.inspectSqliteFile(fullPath);
        result.workspaceHash = workspaceHash;
        results.push(result);
      }
    }
  }

  private async inspectSqliteFile(filePath: string): Promise<DiscoveryResult> {
    if (!this.sqliteReader) {
      return {
        path: filePath,
        type: 'sqlite',
        schemaVersion: 'sqlite-unknown',
        sessionCount: 0,
        errors: [
          'SQLite reading is not available. Reload the extension (F5) to enable it.',
        ],
      };
    }

    const res = await this.sqliteReader.readSessions(filePath);
    const schemaHint = res.isConversationData
      ? `sqlite:${res.schemaUsed}`
      : res.tableNames.length > 0
        ? `sqlite:tables=[${res.tableNames.join(',')}]`
        : 'sqlite-unknown';

    const errors = [...res.errors];
    if (!res.isConversationData && res.errors.length === 0) {
      const hint =
        res.tableNames.length > 0
          ? `Tables found: ${res.tableNames.join(', ')}. This does not appear to contain Copilot Chat conversations.`
          : 'No recognisable tables found.';
      errors.push(hint);
    }

    return {
      path: filePath,
      type: 'sqlite',
      schemaVersion: schemaHint,
      sessionCount: res.sessions.length,
      errors,
      tableNames: res.tableNames,
    };
  }

  private async inspectJsonlDir(dirPath: string): Promise<DiscoveryResult> {
    if (!this.sqliteReader) {
      return {
        path: dirPath,
        type: 'jsonl',
        schemaVersion: 'jsonl-unavailable',
        sessionCount: 0,
        errors: ['SQLite/JSONL reading is not available. Reload the extension (F5) to enable it.'],
      };
    }
    const res = await this.sqliteReader.readJsonlDir(dirPath);
    return {
      path: dirPath,
      type: 'jsonl',
      schemaVersion: res.isConversationData ? `jsonl:${res.schemaUsed}` : 'jsonl',
      sessionCount: res.sessions.length,
      errors: res.errors,
    };
  }

  private inspectJsonFile(filePath: string): DiscoveryResult | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!isObject(data)) {
      return null;
    }

    if (!looksLikeSessionContainer(data)) {
      return null;
    }

    const schemaVersion = detectSchemaVersion(data);
    const sessionCount = countSessions(data);

    return {
      path: filePath,
      type: 'json',
      schemaVersion,
      sessionCount,
      errors: [],
    };
  }
}

// ── Schema-detection helpers (pure functions, exported for tests) ─────────────

export function looksLikeSessionContainer(data: Record<string, unknown>): boolean {
  return (
    (Array.isArray(data['sessions']) && (data['sessions'] as unknown[]).length > 0) ||
    (Array.isArray(data['conversations']) && (data['conversations'] as unknown[]).length > 0) ||
    (Array.isArray(data['chatSessions']) && (data['chatSessions'] as unknown[]).length > 0) ||
    // Single-session file
    (typeof data['id'] === 'string' &&
      (Array.isArray(data['requests']) ||
        Array.isArray(data['messages']) ||
        Array.isArray(data['turns']) ||
        Array.isArray(data['exchanges'])))
  );
}

export function detectSchemaVersion(data: Record<string, unknown>): string {
  if (typeof data['schemaVersion'] === 'string') {
    return `v${data['schemaVersion']}`;
  }
  if (typeof data['version'] === 'string' || typeof data['version'] === 'number') {
    return `v${data['version']}`;
  }

  // Infer from shape
  if (Array.isArray(data['conversations'])) {
    return 'v2-inferred';
  }
  if (Array.isArray(data['chatSessions'])) {
    return 'v3-inferred';
  }
  if (Array.isArray(data['sessions'])) {
    return 'v1-inferred';
  }
  if (typeof data['id'] === 'string' && Array.isArray(data['messages'])) {
    return 'v4-single';
  }
  return 'unknown';
}

export function countSessions(data: Record<string, unknown>): number {
  if (Array.isArray(data['sessions'])) {
    return (data['sessions'] as unknown[]).length;
  }
  if (Array.isArray(data['conversations'])) {
    return (data['conversations'] as unknown[]).length;
  }
  if (Array.isArray(data['chatSessions'])) {
    return (data['chatSessions'] as unknown[]).length;
  }
  if (typeof data['id'] === 'string') {
    return 1; // Single-session file
  }
  return 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
