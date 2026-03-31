import * as fs from 'fs';
import * as path from 'path';
import { SessionWithMessages, Message } from '../models/types';
import { ParserService, parseV5, parseDate } from './parserService';

export interface SqliteReadResult {
  sessions: SessionWithMessages[];
  tableNames: string[];
  errors: string[];
  /** True if the file contained recognisable conversation data */
  isConversationData: boolean;
  schemaUsed: string;
}

// Module-level cache so we only initialise sql.js once per extension lifetime
let _sqlJs: any = null;

async function loadSqlJs(extensionPath: string): Promise<any> {
  if (_sqlJs) {
    return _sqlJs;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJs = require('sql.js');
  _sqlJs = await initSqlJs({
    // In development the WASM lives in node_modules; in a packaged VSIX it
    // should be copied to media/ — we try both locations.
    locateFile: (file: string) => {
      const fromNodeModules = path.join(
        extensionPath,
        'node_modules',
        'sql.js',
        'dist',
        file,
      );
      const fromMedia = path.join(extensionPath, 'media', file);
      return fs.existsSync(fromMedia) ? fromMedia : fromNodeModules;
    },
  });
  return _sqlJs;
}

function rawToString(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('utf-8');
  }
  return null;
}

// Known conversation-like table names that Copilot Chat or VS Code may use
const CONVERSATION_TABLE_CANDIDATES = [
  'conversations',
  'Conversations',
  'sessions',
  'Sessions',
  'chatSessions',
  'chat_sessions',
  'chats',
  'Chats',
  'messages',
  'Messages',
  'turns',
  'Turns',
];

// JSON blob column names that might hold serialised session data
const JSON_COLUMN_CANDIDATES = [
  'data',
  'json',
  'value',
  'content',
  'sessionData',
  'session_data',
  'payload',
];

// ── JSONL event-log helpers ───────────────────────────────────────────────────

/**
 * Deep-set a value at a key-path (array of string keys) inside `obj`.
 * Works for both plain objects and arrays (numeric string keys index into arrays).
 */
function deepSet(obj: any, keys: readonly string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Replay a `chatSessions/<sessionId>.jsonl` event-log file and return a flat
 * list of alternating user / assistant Message objects.
 *
 * The format is one JSON object per line:
 *   kind:0  → full initial state  { kind:0, v: { version, requests:[], … } }
 *   kind:1  → set single key path  { kind:1, k: ["customTitle"], v: "…" }
 *   kind:2  → replace at key path  { kind:2, k: ["requests"], v: […] }
 *   kind:3  → update array item    { kind:3, k: ["requests"], i: 2, v: {…} }
 *
 * Each request has:
 *   message.text          → user prompt
 *   response[]            → parts; text parts have NO `kind` field (kind === undefined)
 *                           and their text is in the `value` field.
 */
function readJsonlSession(jsonlPath: string, sessionId: string): Message[] {
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);

  // Replay event log into a single state object
  let state: any = {};
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.kind === 0) {
        state = { ...event.v };
      } else if (event.kind === 1 || event.kind === 2) {
        const keys = event.k as string[];
        // kind:2 targeting a root-level array key means APPEND (push new items),
        // not replace.  VS Code serialises each new chat request as a single-item
        // push via kind:2["requests"].  Deeper paths (e.g. ["requests","67","response"])
        // always mean replace.
        if (
          event.kind === 2 &&
          keys.length === 1 &&
          Array.isArray(event.v) &&
          Array.isArray(state[keys[0]])
        ) {
          state[keys[0]] = (state[keys[0]] as unknown[]).concat(event.v);
        } else {
          deepSet(state, keys, event.v);
        }
      } else if (event.kind === 3) {
        // Array item update: k points to the array, i is the index
        deepSet(state, [...(event.k as string[]), String(event.i)], event.v);
      }
    } catch {
      // Skip malformed lines
    }
  }

  const requests: any[] = Array.isArray(state.requests) ? state.requests : [];
  const messages: Message[] = [];

  for (const req of requests) {
    if (!req) { continue; }

    // ── User message ─────────────────────────────────────────────────────────
    const msgObj = req?.message;
    const userText: string =
      (typeof msgObj?.text === 'string' ? msgObj.text : '') ||
      (Array.isArray(msgObj?.parts) && typeof msgObj.parts[0]?.text === 'string'
        ? msgObj.parts[0].text
        : '');
    if (userText.trim()) {
      messages.push({
        id: `${req.requestId ?? 'req'}-user`,
        sessionId,
        role: 'user',
        timestamp: parseDate(req.timestamp),
        markdownContent: userText,
        codeBlocks: [],
      });
    }

    // ── Assistant response ────────────────────────────────────────────────────
    // Text parts have no `kind` field; their content is in the `value` field.
    // Parts whose trimmed value is exactly ``` are bare code-fence delimiters
    // that VS Code uses to bracket textEditGroup/codeblockUri parts in its UI.
    // They carry no displayable content and produce spurious empty code blocks
    // when concatenated, so we skip them.
    const responseParts: any[] = Array.isArray(req.response) ? req.response : [];
    const segments: string[] = responseParts
      .filter((p: any) => p !== null && p !== undefined && p.kind === undefined)
      .map((p: any) => (typeof p.value === 'string' ? p.value : ''))
      .filter((v: string) => v.trim().length > 0 && v.trim() !== '```')
      .filter((v: string) => v.trim().length > 0);

    const assistantText = segments.join('');
    if (assistantText.trim()) {
      messages.push({
        id: `${req.requestId ?? 'req'}-assistant`,
        sessionId,
        role: 'assistant',
        timestamp: parseDate(req.timestamp),
        markdownContent: assistantText,
        codeBlocks: [],
      });
    }
  }

  return messages;
}

// ─────────────────────────────────────────────────────────────────────────────

export class SqliteReaderService {
  private readonly parser = new ParserService();

  constructor(private readonly extensionPath: string) {}

  async readSessions(filePath: string): Promise<SqliteReadResult> {
    const result: SqliteReadResult = {
      sessions: [],
      tableNames: [],
      errors: [],
      isConversationData: false,
      schemaUsed: 'none',
    };

    let SqlJs: any;
    try {
      SqlJs = await loadSqlJs(this.extensionPath);
    } catch (err) {
      result.errors.push(
        `SQLite engine failed to load: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    let db: any;
    try {
      const buf = fs.readFileSync(filePath);
      db = new SqlJs.Database(buf);
    } catch (err) {
      result.errors.push(
        `Cannot open database: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    try {
      // ── List all tables ────────────────────────────────────────────────────
      const tablesRes = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      result.tableNames = (tablesRes[0]?.values ?? []).map((r: any[]) =>
        String(r[0]),
      );

      // ── Strategy 0: Modern Copilot Chat V5 — chat.ChatSessionStore.index ───
      // Since VS Code 1.90+ / Copilot Chat 1.200+, session METADATA is stored
      // in ItemTable under "chat.ChatSessionStore.index":
      //   { "version": 1, "entries": { "<uuid>": { sessionId, title, lastMessageDate, timing } } }
      //
      // IMPORTANT: The full per-session transcript is NOT in the DB. Each entry
      // only has title/timing metadata. The actual messages live in:
      //   workspaceStorage/<hash>/GitHub.copilot-chat/chat-session-resources/<sessionId>/
      // where each file is a tool-call artifact. The memento/interactive-session
      // key holds GLOBAL workspace input history (not per-session) so it MUST NOT
      // be used to populate individual session messages.
      if (result.tableNames.includes('ItemTable')) {
        let sessionIndexRaw: string | null = null;

        const idxRows = db.exec(
          "SELECT key, value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'",
        ) as any[];
        for (const [key, raw] of idxRows[0]?.values ?? []) {
          const str = rawToString(raw);
          if (!str) { continue; }
          if (String(key) === 'chat.ChatSessionStore.index') { sessionIndexRaw = str; }
        }

        if (sessionIndexRaw) {
          try {
            const indexObj = JSON.parse(sessionIndexRaw) as Record<string, unknown>;

            // ── Try to read per-session content from chat-session-resources ──
            // These files (tool call artifacts) are the closest thing to actual
            // message content that VS Code persists to disk for V5 sessions.
            const hashMatch = filePath.replace(/\\/g, '/').match(/workspaceStorage\/([a-f0-9]{32})\//i);
            const wsHash = hashMatch ? hashMatch[1] : '';

            const sessionMessages: Record<string, Message[]> = {};
            if (wsHash) {
              // chat-session-resources lives inside the workspace hash directory,
              // not one level above it.
              const chatResDir = path.join(
                path.dirname(filePath),
                'GitHub.copilot-chat',
                'chat-session-resources',
              );
              result.errors.push(`[DBG] v5 chatResDir=${chatResDir} exists=${fs.existsSync(chatResDir)}`);
              if (fs.existsSync(chatResDir)) {
                const sessionDirs = fs.readdirSync(chatResDir);
                result.errors.push(`[DBG] chatResDir sessionDirs=${sessionDirs.length}: ${sessionDirs.slice(0,5).join(',')}`);
                for (const sessionId of sessionDirs) {
                  const sessDir = path.join(chatResDir, sessionId);
                  const msgs: Message[] = [];
                  try {
                    const toolDirs = fs.readdirSync(sessDir);
                    for (const toolDir of toolDirs) {
                      const contentFile = path.join(sessDir, toolDir, 'content.txt');
                      if (fs.existsSync(contentFile)) {
                        const content = fs.readFileSync(contentFile, 'utf-8');
                        msgs.push({
                          id: `${sessionId}-tool-${toolDir}`,
                          sessionId,
                          role: 'assistant',
                          timestamp: undefined,
                          markdownContent: `**Tool call: \`${toolDir}\`**\n\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``,
                          codeBlocks: [],
                        });
                      }
                    }
                  } catch { /* ignore unreadable dirs */ }
                  if (msgs.length > 0) {
                    sessionMessages[sessionId] = msgs;
                    result.errors.push(`[DBG] sessionId=${sessionId.substring(0,8)} found ${msgs.length} tool messages`);
                  }
                }
              }
            }

            // ── Read chatSessions/<sessionId>.jsonl for full transcripts ─────
            // These files hold the complete conversation event-log and are the
            // authoritative source of chat content for V5 sessions.  Messages
            // found here OVERRIDE any tool-artifact messages collected above.
            // Check both the workspace-hash level (built-in VS Code Copilot Chat)
            // and inside GitHub.copilot-chat/ (extension-based / vscode-server).
            const chatSessionsAtHash = path.join(path.dirname(filePath), 'chatSessions');
            const chatSessionsInExt  = path.join(path.dirname(filePath), 'GitHub.copilot-chat', 'chatSessions');
            const chatSessionsDir = fs.existsSync(chatSessionsAtHash)
              ? chatSessionsAtHash
              : chatSessionsInExt;
            if (fs.existsSync(chatSessionsDir)) {
              let jsonlFiles: string[];
              try {
                jsonlFiles = fs.readdirSync(chatSessionsDir).filter(f => f.endsWith('.jsonl'));
              } catch {
                jsonlFiles = [];
              }
              result.errors.push(`[DBG] chatSessionsDir has ${jsonlFiles.length} JSONL files`);
              for (const jsonlFile of jsonlFiles) {
                const sid = path.basename(jsonlFile, '.jsonl');
                const jsonlPath = path.join(chatSessionsDir, jsonlFile);
                try {
                  const msgs = readJsonlSession(jsonlPath, sid);
                  if (msgs.length > 0) {
                    sessionMessages[sid] = msgs;
                    result.errors.push(`[DBG] jsonl ${sid.substring(0, 8)} → ${msgs.length} messages`);
                  }
                } catch (e) {
                  result.errors.push(`[DBG] jsonl read error ${sid.substring(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            }

            if (Object.keys(sessionMessages).length > 0) {
              (indexObj as Record<string, unknown>)['_sessionMessages'] = sessionMessages;
            }

            const v5Sessions = parseV5(indexObj, `${filePath}[chat.ChatSessionStore.index]`);
            result.errors.push(
              `[DBG] v5 parseV5 returned ${v5Sessions?.length ?? 0} sessions from ${filePath.replace(/.*workspaceStorage\//,'')}`,
            );
            if (v5Sessions && v5Sessions.length > 0) {
              // Stamp workspaceContext with the workspace hash so the webview
              // can match sessions to their workspace row.
              if (wsHash) {
                for (const s of v5Sessions) {
                  if (!s.workspaceContext) { s.workspaceContext = wsHash; }
                }
              }
              result.errors.push(
                `[DBG] v5 sessions: ${v5Sessions.map(s => `${s.id.substring(0,8)}(msgs=${s.messageCount})`).join(', ')}`,
              );
              result.sessions.push(...v5Sessions);
              result.isConversationData = true;
              result.schemaUsed = 'v5:chat.ChatSessionStore.index';
            }
          } catch (e) {
            result.errors.push(`[DBG] v5 parse error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      // ── Strategy 1: VS Code ItemTable (state.vscdb) ────────────────────────
      // VS Code stores extension state as key→JSON blobs in ItemTable.
      // Copilot Chat uses this for globalState and workspaceState.
      if (result.sessions.length === 0 && result.tableNames.includes('ItemTable')) {
        const rows = db.exec('SELECT key, value FROM ItemTable') as any[];
        for (const rowValues of rows[0]?.values ?? []) {
          const [key, raw] = rowValues as [unknown, unknown];
          const str = rawToString(raw);
          if (!str || str.length < 10) {
            continue;
          }
          try {
            const parsed = this.parser.parseRaw(
              str,
              `${filePath}[${String(key)}]`,
            );
            if (parsed.sessions.length > 0) {
              result.sessions.push(...parsed.sessions);
              result.isConversationData = true;
              result.schemaUsed = 'ItemTable';
            }
          } catch {
            // Not session data — skip this row
          }
        }
      }

      // ── Strategy 2: Direct conversation/session tables ─────────────────────
      if (result.sessions.length === 0) {
        for (const tableName of CONVERSATION_TABLE_CANDIDATES) {
          if (!result.tableNames.includes(tableName)) {
            continue;
          }
          try {
            const rows = db.exec(
              `SELECT * FROM "${tableName}" LIMIT 500`,
            ) as any[];
            if (!rows[0]) {
              continue;
            }
            const cols = rows[0].columns as string[];

            // Try JSON blob columns first
            const jsonCol = cols.find(c =>
              JSON_COLUMN_CANDIDATES.includes(c.toLowerCase()),
            );
            if (jsonCol) {
              const colIdx = cols.indexOf(jsonCol);
              for (const row of rows[0].values as any[][]) {
                const str = rawToString(row[colIdx]);
                if (!str || str.length < 10) {
                  continue;
                }
                try {
                  const parsed = this.parser.parseRaw(str, filePath);
                  if (parsed.sessions.length > 0) {
                    result.sessions.push(...parsed.sessions);
                    result.isConversationData = true;
                    result.schemaUsed = `table:${tableName}:${jsonCol}`;
                  }
                } catch {
                  // skip
                }
              }
            }

            // Try wrapping the whole table as V4-like JSON
            if (result.sessions.length === 0) {
              const synthetic = JSON.stringify({
                schemaVersion: '4',
                id: path.basename(filePath, '.db'),
                title: path.basename(filePath, '.db'),
                messages: rows[0].values.map((row: any[], i: number) => {
                  const obj: Record<string, unknown> = {};
                  cols.forEach((c, ci) => {
                    obj[c] = row[ci];
                  });
                  return {
                    id: String(i),
                    role: 'user',
                    markdownContent: JSON.stringify(obj),
                    timestamp: null,
                    codeBlocks: [],
                  };
                }),
              });
              const parsed = this.parser.parseRaw(synthetic, filePath);
              if (parsed.sessions.length > 0 && parsed.sessions[0].messageCount > 0) {
                result.sessions.push(...parsed.sessions);
                result.isConversationData = true;
                result.schemaUsed = `table:${tableName}:rows-as-messages`;
              }
            }
          } catch (err) {
            result.errors.push(
              `Table "${tableName}" read error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (result.sessions.length > 0) {
            break;
          }
        }
      }
    } finally {
      db.close();
    }

    return result;
  }

  /**
   * Read all `<sessionId>.jsonl` files in a chatSessions directory and return
   * them as a SqliteReadResult.  Used when `state.vscdb` is absent (e.g. on
   * VS Code Server) but JSONL transcripts are present.
   */
  async readJsonlDir(chatSessionsDirPath: string): Promise<SqliteReadResult> {
    const result: SqliteReadResult = {
      sessions: [],
      tableNames: [],
      errors: [],
      isConversationData: false,
      schemaUsed: 'none',
    };

    let jsonlFiles: string[];
    try {
      jsonlFiles = fs.readdirSync(chatSessionsDirPath).filter(f => f.endsWith('.jsonl'));
    } catch (err) {
      result.errors.push(
        `Cannot read chatSessions directory: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    for (const jsonlFile of jsonlFiles) {
      const sid = path.basename(jsonlFile, '.jsonl');
      const jsonlPath = path.join(chatSessionsDirPath, jsonlFile);
      try {
        const messages = readJsonlSession(jsonlPath, sid);
        if (messages.length === 0) { continue; }

        const firstUser = messages.find(m => m.role === 'user');
        const title = firstUser
          ? (firstUser.markdownContent.replace(/```[\s\S]*?```/g, '').trim().slice(0, 80) || sid)
          : sid;

        const timestamps = messages.map(m => m.timestamp).filter((t): t is Date => t instanceof Date);
        const createdAt  = timestamps.length > 0 ? timestamps[0]  : new Date();
        const updatedAt  = timestamps.length > 0 ? timestamps[timestamps.length - 1] : createdAt;

        result.sessions.push({
          id: sid,
          title,
          createdAt,
          updatedAt,
          tags: [],
          messageCount: messages.length,
          filePath: jsonlPath,
          schemaVersion: 'v5',
          messages,
        });
      } catch (e) {
        result.errors.push(
          `JSONL read error for ${sid.substring(0, 8)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (result.sessions.length > 0) {
      result.isConversationData = true;
      result.schemaUsed = 'jsonl:chatSessions';
    }

    return result;
  }
}
