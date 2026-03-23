import * as fs from 'fs';
import * as path from 'path';
import {
  Session,
  Message,
  CodeBlock,
  SessionWithMessages,
  ParsedFile,
} from '../models/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Parse an ISO-string, epoch-ms number, or any recognisable date value */
function parseDate(v: unknown): Date | undefined {
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? undefined : v;
  }
  if (typeof v === 'number') {
    const d = new Date(v > 1e12 ? v : v * 1000); // handle seconds vs ms
    return isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Extract code blocks from markdown content.
 * Returns { blocks, cleanedMarkdown } – the markdown has the fenced blocks
 * left in place; callers decide whether to strip them.
 */
function extractCodeBlocks(md: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fence = /```(\w*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md)) !== null) {
    blocks.push({ language: m[1] || 'text', content: m[2].trimEnd() });
  }
  return blocks;
}

function buildMessage(
  sessionId: string,
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  timestamp: Date | undefined,
): Message {
  return {
    id,
    sessionId,
    role,
    timestamp,
    markdownContent: content,
    codeBlocks: extractCodeBlocks(content),
  };
}

// ── Schema adapters ───────────────────────────────────────────────────────────
// Each adapter returns null if it cannot handle the data.

/**
 * Robustly extract a workspace path string from various field shapes used by
 * different Copilot Chat schema versions:
 *  - string field: workspacePath, workspaceContext, workspace, workspaceFolder, workspaceUri
 *  - object field: workspaceFolder.uri  (VS Code WorkspaceFolder shape)
 *  - array field:  workspaceFolders[0].uri or workspaceFolders[0] string
 */
function extractWorkspacePath(data: Record<string, unknown>): string {
  const STRING_FIELDS = [
    'workspacePath', 'workspaceContext', 'workspace',
    'workspaceFolder', 'workspaceUri', 'folderPath',
  ] as const;

  for (const field of STRING_FIELDS) {
    const raw = data[field];
    if (typeof raw === 'string' && raw.length > 0) {
      return raw;
    }
    // Object shape: { uri: "file:///..." }
    if (isObject(raw)) {
      const uri = (raw as Record<string, unknown>)['uri'];
      if (typeof uri === 'string' && uri.length > 0) {
        return uri;
      }
    }
  }

  // workspaceFolders (plural) array — take first entry
  const folders = data['workspaceFolders'];
  if (Array.isArray(folders) && folders.length > 0) {
    const first = folders[0];
    if (typeof first === 'string') { return first; }
    if (isObject(first)) {
      const uri = (first as Record<string, unknown>)['uri'];
      if (typeof uri === 'string' && uri.length > 0) { return uri; }
    }
  }

  return '';
}

/** Schema V1 – { version, sessions: [{ id, title, createdAt, requests: [{id, message, response, timestamp}] }] } */
function parseV1(
  data: Record<string, unknown>,
  filePath: string,
): SessionWithMessages[] | null {
  const sessions = asArray<unknown>(data['sessions']);
  if (sessions.length === 0) {
    return null;
  }

  const firstSession = sessions[0];
  if (!isObject(firstSession) || !Array.isArray((firstSession as Record<string, unknown>)['requests'])) {
    return null;
  }

  return sessions.filter(isObject).map(s => {
    const sessionId = asString(s['id'], shortId());
    const requests = asArray<unknown>(s['requests']);
    const messages: Message[] = [];

    for (const req of requests.filter(isObject)) {
      const r = req as Record<string, unknown>;
      const ts = parseDate(r['timestamp']);
      messages.push(buildMessage(sessionId, asString(r['id'], shortId()), 'user', asString(r['message']), ts));
      if (typeof r['response'] === 'string' && r['response'].length > 0) {
        messages.push(buildMessage(sessionId, asString(r['responseId'], shortId()), 'assistant', r['response'] as string, ts ? new Date(ts.getTime() + 1000) : undefined));
      }
    }

    const createdAt = parseDate(s['createdAt']) ?? new Date();
    const updatedAt = parseDate(s['updatedAt']) ?? (messages.at(-1)?.timestamp ?? createdAt);

    const session: Session = {
      id: sessionId,
      title: asString(s['title'], deriveTitle(messages)),
      createdAt,
      updatedAt,
      workspaceContext: extractWorkspacePath(s),
      tags: asArray<string>(s['tags']),
      messageCount: messages.length,
      filePath,
      schemaVersion: 'v1',
    };

    return { ...session, messages };
  });
}

/** Schema V2 – { schemaVersion: "2", conversations: [{ id, name, createdAt, workspacePath, turns: [{userMessage, assistantMessage}] }] } */
function parseV2(
  data: Record<string, unknown>,
  filePath: string,
): SessionWithMessages[] | null {
  const conversations = asArray<unknown>(data['conversations']);
  if (conversations.length === 0) {
    return null;
  }

  const first = conversations[0];
  if (!isObject(first)) {
    return null;
  }

  if (!Array.isArray((first as Record<string, unknown>)['turns'])) {
    return null;
  }

  return conversations.filter(isObject).map(conv => {
    const sessionId = asString(conv['id'], shortId());
    const turns = asArray<unknown>(conv['turns']);
    const messages: Message[] = [];

    for (const turn of turns.filter(isObject)) {
      const t = turn as Record<string, unknown>;

      if (isObject(t['userMessage'])) {
        const um = t['userMessage'] as Record<string, unknown>;
        messages.push(buildMessage(sessionId, asString(t['id'], shortId()) + '-u', 'user', asString(um['content']), parseDate(um['timestamp'])));
      }

      if (isObject(t['assistantMessage'])) {
        const am = t['assistantMessage'] as Record<string, unknown>;
        // assistantMessage may have parts array instead of flat content
        let content = asString(am['content']);
        if (!content && Array.isArray(am['parts'])) {
          content = (am['parts'] as unknown[])
            .filter(isObject)
            .map(p => asString((p as Record<string, unknown>)['value']))
            .join('\n\n');
        }
        messages.push(buildMessage(sessionId, asString(t['id'], shortId()) + '-a', 'assistant', content, parseDate(am['timestamp'])));
      }
    }

    const createdAt = parseDate(conv['createdAt']) ?? new Date();
    const updatedAt = parseDate(conv['lastUpdatedAt'] ?? conv['updatedAt']) ?? (messages.at(-1)?.timestamp ?? createdAt);

    const session: Session = {
      id: sessionId,
      title: asString(conv['name'] ?? conv['title'], deriveTitle(messages)),
      createdAt,
      updatedAt,
      workspaceContext: extractWorkspacePath(conv),
      tags: asArray<string>(conv['tags']),
      messageCount: messages.length,
      filePath,
      schemaVersion: 'v2',
    };

    return { ...session, messages };
  });
}

/** Schema V3 – { chatSessions: [{ sessionId, title, entries: [{kind:"request"|"response", text, parts, timestamp}] }] } */
function parseV3(
  data: Record<string, unknown>,
  filePath: string,
): SessionWithMessages[] | null {
  const chatSessions = asArray<unknown>(data['chatSessions']);
  if (chatSessions.length === 0) {
    return null;
  }

  const first = chatSessions[0];
  if (!isObject(first) || !Array.isArray((first as Record<string, unknown>)['entries'])) {
    return null;
  }

  return chatSessions.filter(isObject).map(cs => {
    const sessionId = asString(cs['sessionId'] ?? cs['id'], shortId());
    const entries = asArray<unknown>(cs['entries']);
    const messages: Message[] = [];

    for (const entry of entries.filter(isObject)) {
      const e = entry as Record<string, unknown>;
      const kind = asString(e['kind']);
      const ts = parseDate(e['timestamp']);

      if (kind === 'request') {
        messages.push(buildMessage(sessionId, asString(e['id'], shortId()), 'user', asString(e['text']), ts));
      } else if (kind === 'response') {
        let content = asString(e['text']);
        if (!content && Array.isArray(e['parts'])) {
          content = (e['parts'] as unknown[])
            .filter(isObject)
            .map(p => {
              const part = p as Record<string, unknown>;
              return asString(part['value'] ?? part['content']);
            })
            .join('\n\n');
        }
        messages.push(buildMessage(sessionId, asString(e['id'], shortId()), 'assistant', content, ts));
      }
    }

    const createdAt = parseDate(cs['createdAt']) ?? new Date();
    const updatedAt = parseDate(cs['updatedAt']) ?? (messages.at(-1)?.timestamp ?? createdAt);

    const session: Session = {
      id: sessionId,
      title: asString(cs['title'], deriveTitle(messages)),
      createdAt,
      updatedAt,
      workspaceContext: extractWorkspacePath(cs),
      tags: asArray<string>(cs['tags']),
      messageCount: messages.length,
      filePath,
      schemaVersion: 'v3',
    };

    return { ...session, messages };
  });
}

/** Schema V4 – Single session file: { id, title, messages: [{id, role, content, timestamp}] } */
function parseV4(
  data: Record<string, unknown>,
  filePath: string,
): SessionWithMessages[] | null {
  if (typeof data['id'] !== 'string') {
    return null;
  }

  const rawMessages = asArray<unknown>(data['messages']);
  if (rawMessages.length === 0) {
    return null;
  }

  const sessionId = data['id'] as string;
  const messages: Message[] = rawMessages.filter(isObject).map(m => {
    const msg = m as Record<string, unknown>;
    const role = asString(msg['role']);
    const validRole = (['user', 'assistant', 'system'].includes(role) ? role : 'user') as 'user' | 'assistant' | 'system';
    return buildMessage(sessionId, asString(msg['id'], shortId()), validRole, asString(msg['content'] ?? msg['markdownContent']), parseDate(msg['timestamp']));
  });

  const createdAt = parseDate(data['createdAt']) ?? new Date();
  const updatedAt = parseDate(data['updatedAt']) ?? (messages.at(-1)?.timestamp ?? createdAt);

  const session: Session = {
    id: sessionId,
    title: asString(data['title'], deriveTitle(messages)),
    createdAt,
    updatedAt,
    workspaceContext: asString(data['workspaceContext'] ?? data['workspace']),
    tags: asArray<string>(data['tags']),
    messageCount: messages.length,
    filePath,
    schemaVersion: 'v4',
  };

  return [{ ...session, messages }];
}

/** Ordered list of adapters: first match wins */
const ADAPTERS = [parseV1, parseV2, parseV3, parseV4] as const;

/**
 * Schema V5 — Modern GitHub Copilot Chat (>= 1.200).
 *
 * VS Code stores session metadata in state.vscdb ItemTable under the key
 * "chat.ChatSessionStore.index":
 *   { "version": 1, "entries": { "<uuid>": { sessionId, title, lastMessageDate, timing: { created } } } }
 *
 * User message texts are stored under "memento/interactive-session":
 *   { "history": { "copilot": [ { "inputText": "..." }, ... ] } }
 *
 * This parser accepts data that has EITHER the `version:1 + entries` shape OR
 * the `history.copilot` shape.  The SQLiteReaderService merges both keys and
 * passes the combined object: { version, entries, _inputHistory, _sessionMessages? }.
 *
 * NOTE: The V5 DB schema (chat.ChatSessionStore.index) stores ONLY session
 * metadata (title, timing, isEmpty). The full per-session transcript is NOT
 * persisted in the SQLite DB — it lives in memory and optionally in
 * workspaceStorage/<hash>/GitHub.copilot-chat/chat-session-resources/<id>/.
 *
 * The _inputHistory field is the GLOBAL workspace input history (last ~40 prompts
 * typed across ALL sessions). It MUST NOT be distributed to individual sessions
 * because it is not session-specific — doing so shows the same 40 prompts for
 * every session, making all sessions look identical.
 *
 * _sessionMessages is an optional map of sessionId → Message[] that callers can
 * provide when they have read per-session message files from the filesystem.
 */
export function parseV5(
  data: Record<string, unknown>,
  filePath: string,
): SessionWithMessages[] | null {
  // Must match { version: 1, entries: { ... } }
  if (data['version'] !== 1 || !isObject(data['entries'])) {
    return null;
  }

  const entries = data['entries'] as Record<string, unknown>;
  if (Object.keys(entries).length === 0) {
    return null;
  }

  // Optional per-session messages injected by SqliteReaderService after
  // reading chat-session-resources files from the filesystem.
  const sessionMessages = isObject(data['_sessionMessages'])
    ? (data['_sessionMessages'] as Record<string, Message[]>)
    : {};

  // NOTE: _inputHistory (memento/interactive-session) is INTENTIONALLY NOT USED
  // here. It is a global workspace-level buffer of the last ~40 prompts typed
  // across all sessions. Assigning it to every session produces identical
  // transcripts for all sessions — see GitHub issue for details.

  const sessions: SessionWithMessages[] = [];

  for (const [, rawEntry] of Object.entries(entries)) {
    if (!isObject(rawEntry)) { continue; }
    const entry = rawEntry as Record<string, unknown>;

    // Skip empty/archived sessions — VS Code creates these automatically for
    // every new chat panel but they contain no messages.
    if (entry['isEmpty'] === true) { continue; }

    const sessionId = asString(entry['sessionId']);
    if (!sessionId) { continue; }

    const title   = asString(entry['title'], 'Untitled Session');
    const timing  = isObject(entry['timing']) ? (entry['timing'] as Record<string, unknown>) : {};
    const createdAt = parseDate(timing['created']) ?? new Date();
    const updatedAt = parseDate(entry['lastMessageDate'] ?? timing['lastRequestEnded']) ?? createdAt;

    // Use per-session messages if available (from chat-session-resources files).
    // Fall back to a single synthetic message derived from the session title —
    // the title IS the first user prompt in VS Code Copilot Chat.
    const messages: Message[] = sessionMessages[sessionId]
      ?? [buildMessage(sessionId, `${sessionId}-title`, 'user', title, createdAt)];

    sessions.push({
      id: sessionId,
      title,
      createdAt,
      updatedAt,
      workspaceContext: extractWorkspacePath(entry),
      tags: [],
      messageCount: messages.length,
      filePath,
      schemaVersion: 'v5',
      messages,
    });
  }

  return sessions.length > 0 ? sessions : null;
}

function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) {
    return 'Untitled Session';
  }
  const text = firstUser.markdownContent.replace(/```[\s\S]*?```/g, '').trim();
  return text.length > 80 ? text.slice(0, 77) + '…' : text || 'Untitled Session';
}

// ── Public API ────────────────────────────────────────────────────────────────

export class ParserService {
  /**
   * Parse a file from disk, trying all schema adapters.
   * Returns a ParsedFile with the sessions found and any errors encountered.
   */
  parseFile(filePath: string): ParsedFile {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (e: unknown) {
      return {
        sessions: [],
        schemaVersion: 'unknown',
        errors: [`Cannot read file: ${e instanceof Error ? e.message : String(e)}`],
      };
    }

    return this.parseRaw(raw, filePath);
  }

  /**
   * Parse already-loaded JSON string. filePath is used as source annotation.
   */
  parseRaw(raw: string, filePath: string): ParsedFile {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return { sessions: [], schemaVersion: 'unknown', errors: ['Invalid JSON'] };
    }

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return {
        sessions: [],
        schemaVersion: 'unknown',
        errors: ['Root element must be a JSON object'],
      };
    }

    const obj = data as Record<string, unknown>;

    for (const adapter of ADAPTERS) {
      const result = adapter(obj, filePath);
      if (result !== null) {
        const schemaVersion = (result[0]?.schemaVersion) ?? 'unknown';
        return { sessions: result, schemaVersion, errors: [] };
      }
    }

    return {
      sessions: [],
      schemaVersion: 'unknown',
      errors: [
        'Unrecognised schema. Supported formats: v1 (sessions+requests), v2 (conversations+turns), ' +
          'v3 (chatSessions+entries), v4 (single session with messages array).',
      ],
    };
  }

  // Convenience for importing from user-selected file
  parseImportedFile(filePath: string): ParsedFile {
    const result = this.parseFile(filePath);
    // Tag imported sessions
    for (const session of result.sessions) {
      if (!session.tags.includes('imported')) {
        session.tags.push('imported');
      }
      session.filePath = `imported:${filePath}`;
    }
    return result;
  }
}

// Re-export helpers for tests
export { extractCodeBlocks, parseDate, deriveTitle };
