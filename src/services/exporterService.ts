import { SessionWithMessages, ExportOptions, ExportFormat } from '../models/types';
import { RedactorService } from './redactorService';

const redactor = new RedactorService();

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimestamp(d: Date | undefined): string {
  if (!d) {
    return '';
  }
  return d.toLocaleString();
}

/** Apply redaction if requested, respecting code-blocks toggle */
function prepareSession(
  session: SessionWithMessages,
  options: ExportOptions,
): SessionWithMessages {
  if (!options.redactSecrets) {
    return session;
  }

  const messages = session.messages.map(m => {
    let content = redactor.redact(m.markdownContent).text;
    if (!options.includeFilePaths) {
      content = redactor.redactFilePaths(content);
    }

    const codeBlocks = options.includeCodeBlocks
      ? m.codeBlocks.map(cb => ({
          ...cb,
          content: redactor.redact(cb.content).text,
        }))
      : [];

    return { ...m, markdownContent: content, codeBlocks };
  });

  return { ...session, messages };
}

// ── Standard Markdown export ──────────────────────────────────────────────────

function toMarkdown(session: SessionWithMessages, options: ExportOptions): string {
  const prepared = prepareSession(session, options);
  const lines: string[] = [];

  lines.push(`# ${prepared.title}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Session ID | \`${prepared.id}\` |`);
  if (prepared.workspaceContext) {
    lines.push(`| Workspace | ${prepared.workspaceContext} |`);
  }
  lines.push(`| Created | ${formatTimestamp(prepared.createdAt)} |`);
  lines.push(`| Updated | ${formatTimestamp(prepared.updatedAt)} |`);
  lines.push(`| Messages | ${prepared.messageCount} |`);
  if (prepared.tags.length > 0) {
    lines.push(`| Tags | ${prepared.tags.join(', ')} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of prepared.messages) {
    const roleLabel = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Copilot**' : '**System**';
    const ts = msg.timestamp ? ` *${formatTimestamp(msg.timestamp)}*` : '';

    lines.push(`### ${roleLabel}${ts}`);
    lines.push('');

    if (options.includeCodeBlocks) {
      lines.push(msg.markdownContent.trim());
    } else {
      const noCode = msg.markdownContent.replace(/```[\s\S]*?```/g, '_[code block omitted]_');
      lines.push(noCode.trim());
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ── JSON export ───────────────────────────────────────────────────────────────

function toJson(session: SessionWithMessages, options: ExportOptions): string {
  const prepared = prepareSession(session, options);

  const data = {
    schemaVersion: '4',
    exportedAt: new Date().toISOString(),
    id: prepared.id,
    title: prepared.title,
    createdAt: prepared.createdAt.toISOString(),
    updatedAt: prepared.updatedAt.toISOString(),
    workspaceContext: prepared.workspaceContext,
    tags: prepared.tags,
    messageCount: prepared.messageCount,
    messages: prepared.messages.map(m => ({
      id: m.id,
      role: m.role,
      timestamp: m.timestamp?.toISOString(),
      markdownContent: m.markdownContent,
      codeBlocks: options.includeCodeBlocks
        ? m.codeBlocks.map(cb => ({ language: cb.language, content: cb.content }))
        : [],
    })),
  };

  return JSON.stringify(data, null, 2);
}

// ── Public API ────────────────────────────────────────────────────────────────

export class ExporterService {
  export(session: SessionWithMessages, options: ExportOptions): string {
    switch (options.format) {
      case 'markdown':
        return toMarkdown(session, options);
      case 'json':
        return toJson(session, options);
      default:
        throw new Error(`Unknown export format: ${options.format as string}`);
    }
  }

  /** Return the recommended file extension for a format */
  fileExtension(format: ExportFormat): string {
    switch (format) {
      case 'markdown':
        return '.md';
      case 'json':
        return '.json';
    }
  }

  /** Return a default filename for an export */
  defaultFilename(session: SessionWithMessages, format: ExportFormat): string {
    const slug = session.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const date = session.updatedAt.toISOString().slice(0, 10);
    return `copilot-${slug}-${date}${this.fileExtension(format)}`;
  }
}

export { escapeHtml };
