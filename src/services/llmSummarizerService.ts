import * as vscode from 'vscode';
import { SessionWithMessages, SummaryOptions } from '../models/types';
import { RedactorService } from './redactorService';

const redactor = new RedactorService();

/** Condense all messages into a readable transcript, capped at maxChars. */
function buildTranscript(
  session: SessionWithMessages,
  options: SummaryOptions,
  maxChars = 40_000,
): string {
  const messages = options.redactSecrets
    ? session.messages.map(m => ({
        ...m,
        markdownContent: redactor.redact(m.markdownContent).text,
        codeBlocks: m.codeBlocks.map(cb => ({
          ...cb,
          content: redactor.redact(cb.content).text,
        })),
      }))
    : session.messages;

  const parts: string[] = [];
  let total = 0;

  for (const m of messages) {
    const role = m.role === 'user' ? 'USER' : 'COPILOT';
    let text = m.markdownContent.trim();

    // Strip fenced code blocks when the option is off
    if (!options.includeCodeBlocks) {
      text = text.replace(/```[\s\S]*?```/g, '_[code block omitted]_').trim();
    }

    if (!text) { continue; }
    const entry = `[${role}]\n${text}\n\n`;
    if (total + entry.length > maxChars) {
      parts.push('_[transcript truncated due to length]_\n');
      break;
    }
    parts.push(entry);
    total += entry.length;
  }
  return parts.join('');
}

function buildPrompt(session: SessionWithMessages, options: SummaryOptions, transcript: string): string {
  const codeInstruction = options.includeCodeBlocks
    ? 'Include up to 3 representative code snippets under a "## Notable Code Snippets" section using fenced code blocks.'
    : 'Do NOT include any code blocks or code snippets in the summary.';
  return `You are summarizing a GitHub Copilot chat session for a developer. \
Produce a well-structured Markdown summary that is concise and factual.

SESSION METADATA
- Title: ${session.title}
- Workspace: ${session.workspaceContext || 'Unknown'}
- Messages: ${session.messageCount} (${Math.ceil(session.messageCount / 2)} exchanges)

CHAT TRANSCRIPT
${transcript}

---
Write the summary using exactly the sections below. Omit any section that has nothing to add. \
Use bullet points, be specific, and avoid padding. ${codeInstruction}

# Summary: ${session.title}

## What was this session about?
(1–3 sentences describing the overall goal and context)

## Conversation Flow
(Short bullet list of the key exchanges — what the user asked and what Copilot recommended or did)

## Key Decisions & Recommendations
(Bullet list of the most important decisions, choices, or recommendations made)

## Files & Symbols Referenced
(Bullet list of files, classes, functions, or variables mentioned, if any)
${options.includeCodeBlocks ? `
## Notable Code Snippets
(Up to 3 representative fenced code blocks from the session)
` : ''}
## Open Questions & Next Steps
(Bullet list of unresolved items, TODOs, or suggested next steps, if any)`;
}

/**
 * Summarize a session using the VS Code Language Model API (GitHub Copilot).
 * Returns the LLM-generated Markdown on success.
 * Throws if the model refuses (content blocked, no permission).
 * Returns `null` if no Copilot model is available (caller should fall back).
 */
export async function summarizeWithLlm(
  session: SessionWithMessages,
  options: SummaryOptions,
  token: vscode.CancellationToken,
): Promise<string | null> {
  // Try to obtain an available Copilot model — prefer gpt-4o, accept any
  let models: vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (models.length === 0) {
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    }
  } catch {
    return null; // LM API not available
  }

  if (models.length === 0) {
    return null; // No Copilot model installed / signed in
  }

  const transcript = buildTranscript(session, options);
  const prompt = buildPrompt(session, options, transcript);

  const response = await models[0].sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    token,
  );

  let text = '';
  for await (const chunk of response.text) {
    if (token.isCancellationRequested) { break; }
    text += chunk;
  }

  // LLMs sometimes wrap Markdown output in a ```markdown ... ``` fence — strip it
  text = text.trim().replace(/^```(?:markdown)?\r?\n([\s\S]*?)\r?\n```\s*$/, '$1').trim();

  return text || null;
}
