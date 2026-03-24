// ─── Core Data Model ────────────────────────────────────────────────────────

export interface Session {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  workspaceContext?: string;
  tags: string[];
  sourceVersion?: string;
  messageCount: number;
  /** Absolute path to the source JSON file (or 'imported' for user-imported sessions) */
  filePath: string;
  schemaVersion?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  timestamp?: Date;
  markdownContent: string;
  codeBlocks: CodeBlock[];
  references?: string[];
}

export interface CodeBlock {
  language: string;
  content: string;
  filename?: string;
}

export interface SessionWithMessages extends Session {
  messages: Message[];
}

// ─── Discovery / Diagnostics ─────────────────────────────────────────────────

export interface DiscoveryResult {
  path: string;
  type: 'json' | 'sqlite' | 'unknown';
  schemaVersion: string;
  sessionCount: number;
  errors: string[];
  /** Table names found in the SQLite file (for diagnostics) */
  tableNames?: string[];
  /** Folder name (hash) under workspaceStorage this file belongs to */
  workspaceHash?: string;
}

export interface SearchPath {
  path: string;
  exists: boolean;
  fileCount?: number;
  files?: string[];
}

export interface DiagnosticsInfo {
  osType: string;
  vsCodeDataPaths: string[];
  searchPaths: SearchPath[];
  discoveredFiles: DiscoveryResult[];
  totalSessionsLoaded: number;
  errors: string[];
  timestamp: Date;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export interface ParsedFile {
  sessions: SessionWithMessages[];
  schemaVersion: string;
  errors: string[];
}

// ─── Export / Summary ────────────────────────────────────────────────────────

export type ExportFormat = 'markdown' | 'json';

export interface ExportOptions {
  format: ExportFormat;
  includeCodeBlocks: boolean;
  includeFilePaths: boolean;
  redactSecrets: boolean;
  roleFilter?: 'all' | 'user' | 'assistant';
}

export interface SummaryOptions {
  includeCodeBlocks: boolean;
  redactSecrets: boolean;
}

// ─── UI / Filtering ──────────────────────────────────────────────────────────

export interface FilterOptions {
  query?: string;
  dateFrom?: Date;
  dateTo?: Date;
  tags?: string[];
  workspaceContext?: string;
}

export type SortField = 'createdAt' | 'updatedAt' | 'title' | 'messageCount';
export type SortOrder = 'asc' | 'desc';

export interface SortOptions {
  field: SortField;
  order: SortOrder;
}

// ─── Webview message types ───────────────────────────────────────────────────

export interface WorkspaceInfo {
  /** The hash directory name under workspaceStorage (e.g. "e8b7a5…") */
  hash: string;
  /** Human-readable label (last folder name from workspace.json, or first 8 chars of hash) */
  label: string;
  /** Full decoded folder path from workspace.json (empty string if not available) */
  folderPath: string;
}

export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

export interface SessionListItem {
  id: string;
  title: string;
  createdAt: string;   // ISO string for JSON serialisation
  updatedAt: string;
  workspaceContext?: string;
  tags: string[];
  messageCount: number;
  schemaVersion?: string;
}
