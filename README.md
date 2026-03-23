# Copilot Session Browser

> Browse, search, summarise, and export your GitHub Copilot Chat sessions — entirely locally, with no network calls and no telemetry.

---

## Features

| Feature                   | Description                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **Session Browser**       | Sidebar panel with full-text search, date filtering, and sorting                         |
| **Transcript Viewer**     | Turn-by-turn conversation view with syntax-highlighted code blocks and one-click copy    |
| **Summary**               | Generate Markdown summary with a live inline preview                                     |
| **Export**                | Export sessions as JIRA Markdown, Standard Markdown, or JSON — preview before saving     |
| **Import**                | Re-load a previously exported JSON session file                                          |
| **SQLite Support**        | Reads `.vscdb` and `.db` files directly — no manual data export required                 |
| **Diagnostics**           | Inspect discovered storage paths, file types, database tables, and session counts        |
| **Storage Path Override** | Point the extension at any custom `workspaceStorage`, `globalStorage`, or User directory |
| **Secret Redaction**      | Automatically strips tokens, API keys, passwords, and private keys before any export     |
| **Local-First & Private** | Zero network calls; telemetry is off by default                                          |

---

## Getting Started

After installing the extension from the VS Code Marketplace:

1. Click the **Copilot Session Browser** icon in the Activity Bar (left sidebar).
2. The extension automatically discovers your Copilot Chat sessions.
3. Click any session to open the transcript viewer.

> If no sessions appear, see [Troubleshooting: Sessions Not Found](#troubleshooting-sessions-not-found) below.

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for any of the following:

| Command                                                                     | Description                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Copilot Session Browser: Refresh Session Index`                            | Re-scan local storage and reload the session list                       |
| `Copilot Session Browser: View Session`                                     | Open the selected session transcript in a tab                           |
| `Copilot Session Browser: Summarize Session`                                | Generate an Atlassian Markdown summary panel                            |
| `Copilot Session Browser: Export Session (JIRA Markdown / Markdown / JSON)` | Choose format and options, then preview before copy or save             |
| `Copilot Session Browser: Import Session`                                   | Load a previously exported JSON session into the index                  |
| `Copilot Session Browser: Set Storage Path Override`                        | Set or clear a custom path for session discovery                        |
| `Copilot Session Browser: Diagnostics`                                      | View all discovered files, their types, table names, and session counts |

---

## Extension Settings

Configure the extension in VS Code Settings (`Ctrl+,` / `Cmd+,`):

| Setting                                        | Default | Description                                                                         |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `copilotSessionBrowser.redactSecretsByDefault` | `true`  | Automatically redact secrets (tokens, API keys, passwords) in summaries and exports |
| `copilotSessionBrowser.overrideStoragePath`    | `""`    | Custom path for session discovery. Clears to restore auto-detection.                |
| `copilotSessionBrowser.additionalSearchPaths`  | `[]`    | Extra VS Code User directories to include alongside auto-detected paths             |
| `copilotSessionBrowser.enableTelemetry`        | `false` | Opt-in anonymous usage telemetry                                                    |

---

## Troubleshooting: Sessions Not Found

If the extension does not automatically discover your sessions, you can manually point it to the right location.

### Step 1 — Use the command (recommended)

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **`Copilot Session Browser: Set Storage Path Override`**
3. Enter one of the paths below
4. The extension refreshes automatically

To **restore automatic detection**, run the command again and leave the input blank.

### Step 2 — What path to enter

| Path you provide                | What gets scanned                                      |
| ------------------------------- | ------------------------------------------------------ |
| `...\workspaceStorage`          | All `<hash>\github.copilot-chat\` sub-directories      |
| `...\globalStorage`             | `globalStorage\github.copilot-chat\` directly          |
| `...\Code\User` (or any parent) | Both `globalStorage` and `workspaceStorage` beneath it |

**Common paths by platform:**

**Windows**

```
C:\Users\<you>\AppData\Roaming\Code\User\workspaceStorage
C:\Users\<you>\AppData\Roaming\Code\User
```

**macOS**

```
~/Library/Application Support/Code/User/workspaceStorage
~/Library/Application Support/Code/User
```

**Linux**

```
~/.config/Code/User/workspaceStorage
~/.config/Code/User
```

### Step 3 — Run Diagnostics

Run **`Copilot Session Browser: Diagnostics`** from the Command Palette to see every file the extension found, its format, database table names, and session count. This is the fastest way to identify why sessions may not be appearing.

---

## Security & Privacy

- **No network calls** — all processing is done locally on your machine.
- **Strict Content Security Policy** — all extension webviews run with `default-src 'none'`.
- **Script nonces** — unique per webview session, preventing code injection.
- **Secret redaction** — the following are removed before any export or summary (enabled by default):
  - PEM private keys
  - Bearer tokens
  - AWS access keys
  - GitHub Personal Access Tokens (PATs)
  - Azure storage account keys
  - Database connection string passwords
  - Generic long-form tokens
- **Explicit save actions** — exports are never written to disk without a user-initiated Save dialog.
- **Redaction warning** — the JIRA summary panel displays a visible warning when redaction is disabled.

---

## For Contributors & Developers

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup instructions, build steps, test details, and the internal architecture.
