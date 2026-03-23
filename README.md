# Copilot Session Browser

A VS Code extension to browse, search, summarise, and export GitHub Copilot Chat sessions — locally, privately, and without any network calls.

---

## Features

| Feature               | Details                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| **Session list**      | Sidebar with search, date filter, and sort                                          |
| **Transcript viewer** | Full turn-by-turn conversation with syntax-highlighted code blocks and copy buttons |
| **JIRA summary**      | One-click Atlassian Markdown summary panel with inline preview of generated content |
| **Export**            | JIRA Markdown, Standard Markdown, or re-importable JSON — opens a **preview panel** with copy-to-clipboard and save buttons before writing to disk |
| **Import**            | Load previously exported JSON session files                                         |
| **SQLite support**    | Reads `.vscdb` / `.db` files directly — no manual export required                   |
| **Diagnostics**       | See exactly where the extension searched, what it found, and which DB tables exist  |
| **Path override**     | Point the extension at any `workspaceStorage`, `globalStorage`, or User directory   |
| **Secret redaction**  | Tokens, API keys, passwords, private keys removed before export                     |
| **Local-first**       | No network calls; no telemetry by default                                           |

---

## Running the Extension Locally

### Prerequisites

- Node.js ≥ 18
- VS Code ≥ 1.85

### Steps

```bash
# 1 – Install dependencies
npm install

# 2 – Compile TypeScript
npm run compile

# 3 – Open in VS Code
code .
```

Press **F5** to launch the Extension Development Host.
The "Copilot Sessions" icon appears in the Activity Bar.

---

## Commands

| Command                                                     | Description                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Copilot: Refresh Session Index`                            | Re-scan local storage for sessions                                                           |
| `Copilot: View Session`                                     | Open transcript in editor tab                                                                |
| `Copilot: Summarize Session`                                | Generate an Atlassian Markdown summary and view it in a panel                                |
| `Copilot: Export Session (JIRA Markdown / Markdown / JSON)` | Pick format, redaction, and code-block options, then preview before copy or save             |
| `Copilot: Import Session`                                   | Load a previously exported JSON session file into the index                                  |
| `Copilot: Set Storage Path Override`                        | Interactively set (or clear) the storage path override                                       |
| `Copilot: Diagnostics`                                      | Show storage discovery details including SQLite table names and per-file session counts      |

---

## Running Tests

```bash
npm test
```

Tests use **Mocha** with **ts-node** (no VS Code host required for unit tests).

### Test coverage

- `parser.test.ts` — Schema adapters V1/V2/V4, date parsing, code-block extraction, resilience to unknown schemas
- `redactor.test.ts` — All redaction patterns; safe text untouched; file-path redaction
- `exporter.test.ts` — JIRA/MD/JSON formatting; round-trip JSON; secret redaction; code-block toggle

---

## How Sessions Are Discovered

The extension searches these locations in order (no hardcoded absolute paths):

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

Also searched: `Code - Insiders`, `Code - OSS`, `VSCodium` variants.
Both `.json` and `.vscdb` / `.db` (SQLite) files are read automatically.

### SQLite support

GitHub Copilot Chat stores its session state in SQLite databases (`state.vscdb`, `workspace-chunks.db`, etc.).
The extension reads these using **sql.js** (pure JS/WASM — no native binaries required).
It tries four strategies in order:

0. **`chat.ChatSessionStore.index`** — Modern Copilot Chat (≥ v1.200). Reads the V5 session index from the `ItemTable`. Full transcripts are loaded from per-session JSONL event-log files stored under `workspaceStorage/<hash>/GitHub.copilot-chat/chat-session-resources/<id>/`.
1. **`ItemTable`** — VS Code's standard extension-state schema. Copilot Chat writes its `globalState` here as serialised JSON values, handled by schema adapters V1–V4.
2. **Direct conversation tables** — scans for tables named `conversations`, `sessions`, `chatSessions`, `messages`, etc. and looks for JSON blob columns.
3. **Row-as-message fallback** — wraps raw table rows as messages if no recognised schema is found.

> **Note:** `workspace-chunks.db` is a _code-index_ file, not a chat history file. The extension will open it and list its tables but will report 0 sessions. This is expected. The chat history lives in `state.vscdb`.

Run **Copilot: Diagnostics** to see every file found, its type, table names, and session count.

---

## Overriding the Storage Path

If sessions are not discovered automatically (e.g. because VS Code writes to an unexpected location), you can tell the extension exactly where to look.

### Option 1 — Using the command (recommended)

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **`Copilot: Set Storage Path Override`**
3. Enter the path in the input box (see path options below)
4. The extension refreshes automatically

To **reset to auto-detection**, run the command again and clear the input box.

### Option 2 — Via Settings JSON

Open VS Code Settings (`Ctrl+,`), search for `copilotSessionBrowser.overrideStoragePath`, and set it directly.

### What path to enter

The extension is smart about what you pass:

| Path you provide                | What gets scanned                                      |
| ------------------------------- | ------------------------------------------------------ |
| `...\workspaceStorage`          | All `<hash>\github.copilot-chat\` sub-directories      |
| `...\globalStorage`             | `globalStorage\github.copilot-chat\` directly          |
| `...\Code\User` (any other dir) | Both `globalStorage` and `workspaceStorage` beneath it |

**Common paths on Windows:**

```
# Scan only workspaceStorage (most common fix)
C:\Users\<you>\AppData\Roaming\Code\User\workspaceStorage

# Scan both globalStorage and workspaceStorage
C:\Users\<you>\AppData\Roaming\Code\User

# Scan only globalStorage
C:\Users\<you>\AppData\Roaming\Code\User\globalStorage
```

---

## Supported Session Formats

| Schema | Shape                                                        | Notes                                                                                                                    |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| V1     | `{ sessions: [{ requests: [] }] }`                           | Older Copilot Chat                                                                                                       |
| V2     | `{ conversations: [{ turns: [] }] }`                         | Newer Copilot Chat                                                                                                       |
| V3     | `{ chatSessions: [{ entries: [] }] }`                        | Panel chat variant                                                                                                       |
| V4     | `{ id, messages: [] }`                                       | Extension's own JSON export (round-trip re-import)                                                                       |
| V5     | `{ version: 1, entries: { "<uuid>": { sessionId, … } } }`   | Modern Copilot Chat (≥ v1.200), SQLite-only. Title/timing from `chat.ChatSessionStore.index`; transcript from per-session JSONL files on disk. |

---

## Settings

| Setting                                        | Default | Description                                                                                                                                                            |
| ---------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilotSessionBrowser.overrideStoragePath`    | `""`    | Path override for session discovery. Accepts a `workspaceStorage`, `globalStorage`, or User dir. When set, auto-detection is skipped. Clear to restore auto-detection. |
| `copilotSessionBrowser.additionalSearchPaths`  | `[]`    | Extra VS Code User directories to search in addition to auto-detected paths.                                                                                           |
| `copilotSessionBrowser.redactSecretsByDefault` | `true`  | Redact secrets in summaries and exports by default.                                                                                                                    |
| `copilotSessionBrowser.enableTelemetry`        | `false` | Anonymous usage telemetry (opt-in).                                                                                                                                    |

---

## Security

- All webviews use a strict Content Security Policy (`default-src 'none'`).
- Script nonces are generated per webview session.
- Redacted patterns: PEM private keys, Bearer tokens, AWS keys, GitHub PATs, Azure account keys, database passwords, generic long tokens.
- Exports always require explicit user action (Save dialog).
- JIRA summary panel shows a preview with a warning when redaction is off.

---

## Project Structure

See [DESIGN.md](./DESIGN.md) for the full technical design, data model, and architecture diagram.
