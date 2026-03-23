# Development Guide — Copilot Session Browser

This document covers everything needed to build, run, test, and extend the extension locally.

---

## Prerequisites

- **Node.js** ≥ 18
- **VS Code** ≥ 1.85
- **TypeScript** (installed via `npm install`)

---

## Local Setup

```bash
# 1 – Install dependencies
npm install

# 2 – Compile TypeScript
npm run compile

# 3 – Open in VS Code
code .
```

Press **F5** to launch the Extension Development Host. The **Copilot Session Browser** icon will appear in the Activity Bar.

### Available Scripts

| Script | Command | Description |
| --- | --- | --- |
| Compile | `npm run compile` | Compile TypeScript once |
| Watch | `npm run watch` | Compile in watch mode |
| Test | `npm test` | Run all unit tests |
| Lint | `npm run lint` | Run ESLint on `src/` |
| Package | `vsce package` | Build a `.vsix` for local install |

---

## Running Tests

Tests use **Mocha** with **ts-node** and do not require the VS Code host to be running.

```bash
npm test
```

### Test Coverage

| File | What is tested |
| --- | --- |
| `parser.test.ts` | Schema adapters V1/V2/V4, date parsing, code-block extraction, and resilience to unknown schemas |
| `redactor.test.ts` | All redaction pattern matches; safe text left untouched; file-path redaction |
| `exporter.test.ts` | JIRA/MD/JSON output formatting; round-trip JSON re-import; secret redaction; code-block toggle |

---

## Project Structure

```
src/
  extension.ts                  # Entry point — registers commands and providers
  models/
    types.ts                    # Shared TypeScript types and interfaces
  panels/
    diagnosticsPanel.ts         # Diagnostics webview
    previewPanel.ts             # Export preview webview
    summaryPanel.ts             # JIRA summary webview
    transcriptPanel.ts          # Session transcript webview
  providers/
    sessionListProvider.ts      # Webview provider for the sidebar session list
  services/
    discoveryService.ts         # Locates Copilot Chat storage directories
    exporterService.ts          # Formats sessions as JIRA MD / MD / JSON
    indexService.ts             # Builds and manages the in-memory session index
    llmSummarizerService.ts     # Generates JIRA-style summaries
    parserService.ts            # Schema adapters for V1–V5 session formats
    redactorService.ts          # Secret pattern redaction
    sqliteReaderService.ts      # sql.js-based SQLite reader
    summarizerService.ts        # Plain-text summarisation utilities
  utils/
    markdownRenderer.ts         # Shared Markdown-to-HTML rendering
media/
  sessionList.js                # Browser-side JS for the sidebar webview
test/
  fixtures/                     # Sample session JSON files (V1, V2, V4)
  suite/                        # Mocha test suites
```

See [DESIGN.md](./DESIGN.md) for the full architecture diagram and data model.

---

## How Sessions Are Discovered

The extension searches these paths automatically — no hardcoded absolute paths are used:

```
Windows:
  %APPDATA%\Code\User\globalStorage\github.copilot-chat\*
  %APPDATA%\Code\User\workspaceStorage\<hash>\github.copilot-chat\*

macOS:
  ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/*
  ~/Library/Application Support/Code/User/workspaceStorage/<hash>/github.copilot-chat/*

Linux:
  $XDG_CONFIG_HOME/Code/User/globalStorage/github.copilot-chat/*
  $XDG_CONFIG_HOME/Code/User/workspaceStorage/<hash>/github.copilot-chat/*
```

Also searched: `Code - Insiders`, `Code - OSS`, and `VSCodium` variants.
Both `.json` and `.vscdb` / `.db` (SQLite) files are read automatically.

---

## SQLite Reading Strategy

GitHub Copilot Chat stores session state in SQLite databases (`state.vscdb`, `workspace-chunks.db`, etc.). The extension reads these using **sql.js** (pure JS/WASM — no native binaries required).

It tries four strategies in order:

| # | Strategy | Description |
| --- | --- | --- |
| 0 | `chat.ChatSessionStore.index` | Modern Copilot Chat (≥ v1.200). Reads a V5 session index from `ItemTable`. Transcripts are loaded from per-session JSONL files under `workspaceStorage/<hash>/GitHub.copilot-chat/chat-session-resources/<id>/`. |
| 1 | `ItemTable` | VS Code's standard extension-state schema. Copilot Chat writes `globalState` here as serialised JSON, handled by schema adapters V1–V4. |
| 2 | Direct conversation tables | Scans for tables named `conversations`, `sessions`, `chatSessions`, `messages`, etc., and reads JSON blob columns. |
| 3 | Row-as-message fallback | Wraps raw table rows as synthetic messages if no recognised schema is found. |

> **Note:** `workspace-chunks.db` is a code-index file, not a chat history file. The extension will open it and list its tables but will report 0 sessions — this is expected. Chat history lives in `state.vscdb`.

---

## Supported Session Schemas

| Schema | Shape | Notes |
| --- | --- | --- |
| V1 | `{ sessions: [{ requests: [] }] }` | Older Copilot Chat |
| V2 | `{ conversations: [{ turns: [] }] }` | Newer Copilot Chat |
| V3 | `{ chatSessions: [{ entries: [] }] }` | Panel chat variant |
| V4 | `{ id, messages: [] }` | Extension's own JSON export (round-trip re-import) |
| V5 | `{ version: 1, entries: { "<uuid>": { sessionId, … } } }` | Modern Copilot Chat (≥ v1.200), SQLite-only. Title and timing come from `chat.ChatSessionStore.index`; transcript from per-session JSONL files. |

---

## Packaging & Publishing

```bash
# Install vsce if not already installed
npm install -g @vscode/vsce

# Build the extension package
vsce package

# Publish to the VS Code Marketplace
vsce publish
```

Ensure `vscode:prepublish` in `package.json` runs `npm run compile` (already configured).
