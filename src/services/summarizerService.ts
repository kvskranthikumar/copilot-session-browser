import { SessionWithMessages, Message, CodeBlock, SummaryOptions } from '../models/types';
import { RedactorService } from './redactorService';

const redactor = new RedactorService();

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/\[/g, '\\[');
}

function formatDateRange(session: SessionWithMessages): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  const start = session.createdAt.toLocaleString(undefined, opts);
  const end = session.updatedAt.toLocaleString(undefined, opts);
  return start === end ? start : `${start} → ${end}`;
}

/** Strip code fences and inline code; return clean prose */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '')
    .trim();
}

/** First substantial user message — what the user was trying to accomplish */
function extractGoal(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') { continue; }
    const text = stripCode(m.markdownContent);
    if (text.length > 20) { return text.slice(0, 600); }
  }
  return '';
}

/**
 * Build a Q&A thread timeline: pair each user message with the gist of the
 * assistant reply, producing a readable narrative of what happened.
 */
interface Turn {
  userText: string;
  assistantGist: string;
}

function buildTimeline(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role === 'user') {
      const userText = stripCode(messages[i].markdownContent).slice(0, 300);
      i++;
      let assistantGist = '';
      if (i < messages.length && messages[i].role === 'assistant') {
        assistantGist = summariseAssistant(messages[i].markdownContent);
        i++;
      }
      if (userText.trim()) {
        turns.push({ userText, assistantGist });
      }
    } else {
      i++;
    }
  }
  return turns;
}

/**
 * Condense an assistant message into at most 3 representative sentences.
 * Prefers the first sentence of the first substantive paragraph.
 */
function summariseAssistant(text: string): string {
  const prose = stripCode(text);
  // Split into non-empty paragraphs
  const paragraphs = prose.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 30);
  const sentences: string[] = [];
  for (const para of paragraphs) {
    // Split on sentence boundaries
    const parts = para.match(/[^.!?]+[.!?]+/g) ?? [para];
    for (const s of parts) {
      const clean = s.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length > 20) { sentences.push(clean); }
      if (sentences.length >= 3) { break; }
    }
    if (sentences.length >= 3) { break; }
  }
  return sentences.join(' ').slice(0, 500);
}

/** Identify the dominant topics from user messages (keyword frequency) */
function extractTopics(messages: Message[]): string[] {
  const stopWords = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'is','it','this','that','be','as','from','by','can','i','my','your',
    'how','do','we','what','when','where','should','would','could','please',
    'me','not','if','are','was','will','have','has','had','so','use','just',
    'does','need','want','get',
  ]);
  const freq = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== 'user') { continue; }
    const words = stripCode(m.markdownContent)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/);
    for (const w of words) {
      if (w.length < 4 || stopWords.has(w)) { continue; }
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
}

/** Lines that signal a key decision or recommendation from the assistant */
const DECISION_PATTERNS = [
  /\bI[''']?ll use\b/i,
  /\bwe[''']?(?:ll|'ll)?\s+(?:use|go with|decided|chose|opted)\b/i,
  /\bthe (?:solution|approach|fix) (?:is|was)\b/i,
  /\bbest approach\b/i,
  /\brecommend(?:ed|s)?\b/i,
  /\byou should\b/i,
  /\buse .+ instead\b/i,
  /\bswitched? to\b/i,
  /\broot cause\b/i,
  /\bfixed by\b/i,
];

function extractDecisions(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') { continue; }
    for (const line of m.markdownContent.split('\n')) {
      const clean = line.replace(/^\s*[-*#>]+\s*/, '').trim();
      if (clean.length < 20 || clean.length > 300) { continue; }
      if (DECISION_PATTERNS.some(p => p.test(clean))) { out.push(clean); }
    }
  }
  return [...new Set(out)].slice(0, 8);
}

/** Files or symbols that were mentioned as changed */
function extractFilesChanged(messages: Message[]): string[] {
  const FILE_RE = /`([^`\s]+\.[a-z]{1,6})`/gi;
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') { continue; }
    let match;
    while ((match = FILE_RE.exec(m.markdownContent)) !== null) {
      // Filter out noise like single-word.ts that look like real file names
      const name = match[1];
      if (name.includes('/') || /\.[a-z]{2,4}$/.test(name)) {
        seen.add(name);
      }
    }
  }
  return [...seen].slice(0, 12);
}

/** User questions that were left open or marked TODO/FIXME */
const TODO_PATTERNS = [/\bTODO\b/i, /\bFIXME\b/i, /\bopen question\b/i, /\bnot yet\b/i, /\bnext step\b/i];

function extractOpenItems(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const line of m.markdownContent.split('\n')) {
      const clean = line.replace(/^\s*[-*#>]+\s*/, '').trim();
      if (clean.length < 15) { continue; }
      if (TODO_PATTERNS.some(p => p.test(clean)) ||
          (m.role === 'user' && clean.endsWith('?') && clean.length > 20)) {
        out.push(clean.slice(0, 200));
      }
    }
  }
  return [...new Set(out)].slice(0, 8);
}

/** Select up to N representative code blocks (unique, non-trivial) */
function pickSnippets(messages: Message[], maxCount: number): CodeBlock[] {
  const seen = new Set<string>();
  const snippets: CodeBlock[] = [];
  for (const m of messages) {
    for (const cb of m.codeBlocks) {
      const key = cb.content.trim().slice(0, 60);
      if (seen.has(key) || cb.content.trim().length < 20) { continue; }
      seen.add(key);
      snippets.push(cb);
      if (snippets.length >= maxCount) { return snippets; }
    }
  }
  return snippets;
}

// ── Main builder ──────────────────────────────────────────────────────────────

function buildSummary(
  session: SessionWithMessages,
  options: SummaryOptions,
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

  const goal      = extractGoal(messages);
  const topics    = extractTopics(messages);
  const timeline  = buildTimeline(messages);
  const decisions = extractDecisions(messages);
  const files     = extractFilesChanged(messages);
  const openItems = extractOpenItems(messages);
  const snippets  = options.includeCodeBlocks ? pickSnippets(messages, 3) : [];

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push('# Copilot Chat Session Summary');
  lines.push('');
  lines.push(`**Session:** ${esc(session.title)}`);
  if (session.workspaceContext) {
    lines.push(`**Workspace:** ${esc(session.workspaceContext)}`);
  }
  lines.push(`**Date:** ${formatDateRange(session)}`);
  lines.push(`**Turns:** ${Math.ceil(session.messageCount / 2)} exchanges (${session.messageCount} messages)`);
  lines.push('');

  // ── What was this session about ───────────────────────────────────────────
  lines.push('## What was this session about?');
  lines.push('');
  if (goal) {
    lines.push(goal);
  } else {
    lines.push('_Could not determine a clear starting goal from the messages._');
  }
  if (topics.length > 0) {
    lines.push('');
    lines.push(`**Key topics mentioned:** ${topics.join(', ')}`);
  }
  lines.push('');

  // ── Conversation flow ─────────────────────────────────────────────────────
  if (timeline.length > 0) {
    lines.push('## Conversation Flow');
    lines.push('');
    // Show up to 8 turns to keep it readable
    const shownTurns = timeline.slice(0, 8);
    for (let idx = 0; idx < shownTurns.length; idx++) {
      const t = shownTurns[idx];
      lines.push(`**${idx + 1}. User asked:** ${esc(t.userText)}`);
      if (t.assistantGist) {
        lines.push(`   → ${esc(t.assistantGist)}`);
      }
      lines.push('');
    }
    if (timeline.length > 8) {
      lines.push(`_…and ${timeline.length - 8} more exchanges not shown._`);
      lines.push('');
    }
  }

  // ── Key decisions ─────────────────────────────────────────────────────────
  lines.push('## Key Decisions & Recommendations');
  lines.push('');
  if (decisions.length > 0) {
    for (const d of decisions) {
      lines.push(`- ${esc(d)}`);
    }
  } else {
    lines.push('- _No explicit decisions or recommendations detected._');
  }
  lines.push('');

  // ── Files / artefacts touched ─────────────────────────────────────────────
  if (files.length > 0) {
    lines.push('## Files & Symbols Referenced');
    lines.push('');
    for (const f of files) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  // ── Code snippets ─────────────────────────────────────────────────────────
  if (snippets.length > 0) {
    lines.push('## Notable Code Snippets');
    lines.push('');
    for (const snippet of snippets) {
      const lang = snippet.language || 'text';
      lines.push('```' + lang);
      lines.push(snippet.content.trim());
      lines.push('```');
      lines.push('');
    }
  }

  // ── Open questions / next steps ───────────────────────────────────────────
  lines.push('## Open Questions & Next Steps');
  lines.push('');
  if (openItems.length > 0) {
    for (const item of openItems) {
      lines.push(`- [ ] ${esc(item)}`);
    }
  } else {
    lines.push('- [ ] _None detected_');
  }
  lines.push('');

  // ── Meta ──────────────────────────────────────────────────────────────────
  lines.push('---');
  lines.push(`*Session ID: \`${session.id}\`*`);
  if (session.filePath && !session.filePath.startsWith('imported:')) {
    lines.push(`*Source: available locally*`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export class SummarizerService {
  summarize(session: SessionWithMessages, options: SummaryOptions): string {
    return buildSummary(session, options);
  }
}
