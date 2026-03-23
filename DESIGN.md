# Copilot Session Browser — Technical Design

## Overview

**Copilot Session Browser** is a VS Code extension that discovers, indexes, and presents GitHub Copilot Chat sessions from local storage. It is read-only and local-first: no data is ever uploaded, telemetry is off by default, and secrets are redacted before any content leaves the extension.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                │
│                                                          │
│  extension.ts   ← registers commands + providers        │
│       │                                                  │
│       ├── DiscoveryService   find local storage files    │
│       ├── ParserService      schema adapters             │
│       ├── IndexService       in-memory session index     │
│       ├── RedactorService    regex-based secret removal  │
│       ├── SummarizerService  JIRA Markdown generation    │
│       └── ExporterService    JIRA / MD / JSON export     │
│                                                          │
│  SessionListProvider  (WebviewViewProvider – sidebar)    │
│  TranscriptPanel      (WebviewPanel – editor tab)        │
│  SummaryPanel         (WebviewPanel – editor tab)        │
│  DiagnosticsPanel     (WebviewPanel – editor tab)        │
└──────────────────────────────────────────────────────────┘
            │ postMessage / onDidReceiveMessage
            ▼
┌──────────────────────────────────────────────────────────┐
│                    Webview (browser sandbox)             │
│  Plain HTML + vanilla JS                                 │
│  No external CDN; all rendering done server-side         │
└──────────────────────────────────────────────────────────┘
```

---

## Data Model

### Session (normalised)

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique session identifier |
| `title` | `string` | Human-readable title (derived from first user message if not explicit) |
| `createdAt` | `Date` | Session start time |
| `updatedAt` | `Date` | Last message time |
| `workspaceContext` | `string?` | Workspace/repo path if available |
| `tags` | `string[]` | User-defined or auto-assigned labels |
| `messageCount` | `number` | Total message count |
| `filePath` | `string` | Source file on disk (or `imported:…` for user imports) |
| `schemaVersion` | `string?` | Detected schema version |

### Message

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique message identifier |
| `sessionId` | `string` | Parent session |
| `role` | `'user' \| 'assistant' \| 'system'` | Who wrote this |
| `timestamp` | `Date?` | When written |
| `markdownContent` | `string` | Full message text in Markdown |
| `codeBlocks` | `CodeBlock[]` | Extracted fenced code blocks |

---

## Ingestion / Discovery Strategy

The extension does **not** assume a specific file path. Instead it:

1. **Detects the VS Code user-data root** for the current OS:
   - Windows: `%APPDATA%\Code\User\` (and `Code - Insiders`, `Code - OSS`)
   - macOS: `~/Library/Application Support/Code/User/`
   - Linux: `$XDG_CONFIG_HOME/Code/User/` (or `~/.config/Code/User/`)

2. **Searches two directories** for JSON files belonging to `github.copilot-chat`:
   - `<userData>/globalStorage/github.copilot-chat/`
   - `<userData>/workspaceStorage/<hash>/github.copilot-chat/`

3. **Applies heuristics** to determine whether a JSON file contains sessions (checks for `sessions`, `conversations`, `chatSessions` arrays, or single-session shape).

4. **Tries four schema adapters** in order; first match wins and the session is normalised to the internal model.

5. **Detects SQLite databases** (`*.vscdb`) but does not attempt to read them (native binaries not available). Diagnostics clearly reports this.

6. **Additional paths** can be provided via the `copilotSessionBrowser.additionalSearchPaths` setting.

7. **Imported files** (via the Import command) are parsed the same way and tagged `imported`.

---

## Schema Adapters

| Adapter | Trigger | Source shape |
|---|---|---|
| V1 | `sessions[].requests[]` | Older Copilot Chat format |
| V2 | `conversations[].turns[]` | Newer format with user/assistant turn pairs |
| V3 | `chatSessions[].entries[]` | VS Code panel chat format with `kind` entries |
| V4 | Top-level `id` + `messages[]` | Single-session export / our own JSON export |

---

## Security and Privacy

- **Local-only**: no network calls; no telemetry by default.
- **Redaction** (`RedactorService`) removes before summary/export:
  - PEM private keys
  - Bearer tokens
  - AWS access/secret keys
  - GitHub / GitLab PATs
  - Azure storage account keys
  - Generic long-random tokens (≥40 chars)
  - Passwords in connection strings and URLs
  - Absolute file paths (optional)
- **Export preview**: `SummaryPanel` shows the JIRA markdown before any action, with a warning if redaction is disabled.
- **Explicit action required** for all exports; no background writes.
- **Content Security Policy** applied to all webviews: `default-src 'none'`; scripts use per-session nonces.

---

## Summarisation (JIRA Markdown)

`SummarizerService` applies rule-based extraction (no external AI calls):

| Section | How derived |
|---|---|
| Problem / Goal | First substantial user message (code blocks stripped) |
| Key Decisions | Assistant lines matching decision-language patterns (recommends, will use, best approach, …) |
| What Changed | Assistant lines matching change-language patterns (updated, added, implemented, …) |
| Helpful Snippets | First 2 (short) or 4 (detailed) unique, non-trivial code blocks |
| Open Questions | Lines containing `TODO`, `FIXME`, or user questions ending with `?` |
| Risks / Gotchas | Assistant lines mentioning warnings, caveats, deprecation, avoid, … |
| References | Session ID and source attribution |

---

## Performance

- **Incremental indexing**: `IndexService.upsertAll()` only adds/updates changed sessions.
- **Session list rendering**: all search/filter/sort is done client-side in the webview after the initial `sessions` message; no round-trips to the extension host for filtering.
- **Message cap in search**: full-text search scans only the first 10 messages to avoid O(N×M) cost for large sessions.
- **No background indexing**: refresh is explicit (command or startup).

---

## File Layout

```
CopilotSessionBrowser/
├── package.json            Extension manifest + commands
├── tsconfig.json           TypeScript (strict, ES2020, CommonJS)
├── tsconfig.test.json      Test-only tsconfig (includes test/)
├── src/
│   ├── extension.ts        Activation, command registration
│   ├── models/
│   │   └── types.ts        Shared TypeScript interfaces
│   ├── services/
│   │   ├── discoveryService.ts
│   │   ├── parserService.ts
│   │   ├── indexService.ts
│   │   ├── redactorService.ts
│   │   ├── summarizerService.ts
│   │   └── exporterService.ts
│   ├── providers/
│   │   └── sessionListProvider.ts   Sidebar WebviewViewProvider
│   ├── panels/
│   │   ├── transcriptPanel.ts
│   │   ├── summaryPanel.ts
│   │   └── diagnosticsPanel.ts
│   └── utils/
│       └── markdownRenderer.ts      Markdown → HTML (node-side)
├── media/
│   └── icon.svg
└── test/
    ├── fixtures/
    │   ├── session-v1.json
    │   ├── session-v2.json
    │   └── session-v4.json
    └── suite/
        ├── parser.test.ts
        ├── redactor.test.ts
        └── exporter.test.ts
```
