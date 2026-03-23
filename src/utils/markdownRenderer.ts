/**
 * Minimal Markdown → HTML renderer.
 *
 * Runs in the extension host (Node.js), not in the webview.  The output is
 * sanitised before being embedded in webview HTML.
 *
 * Supports:
 *   - Fenced code blocks (```lang … ```)
 *   - Inline code
 *   - Bold / italic / bold-italic
 *   - ATX headings (# through ####)
 *   - Unordered lists (-, *, •)
 *   - Ordered lists (1. 2. …)
 *   - Task lists (- [ ] / - [x])
 *   - Blockquotes (>)
 *   - Horizontal rules (---, ***)
 *   - Links (rendered as non-clickable spans for safety)
 *   - Paragraph wrapping
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render markdown to HTML with code-block wiring for copy buttons.
 * codeBlocks receives all code blocks in order so the caller can provide
 * copy functionality by index.
 */
export function renderMarkdown(
  md: string,
  codeBlockSink?: { language: string; content: string }[],
): string {
  let html = md;

  // ── 1. Extract fenced code blocks ─────────────────────────────────────────
  const storedBlocks: string[] = [];

  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_full, lang, code) => {
    const idx = storedBlocks.length;
    const language = (lang as string).trim() || 'text';
    const escapedCode = escapeHtml((code as string).trimEnd());

    if (codeBlockSink) {
      codeBlockSink.push({ language, content: (code as string).trimEnd() });
    }

    const block =
      `<div class="code-block" data-language="${escapeAttr(language)}">` +
      `<div class="code-header">` +
      `<span class="code-lang">${escapeHtml(language)}</span>` +
      `<button class="copy-btn" data-idx="${idx}" aria-label="Copy code to clipboard">Copy</button>` +
      `</div>` +
      `<pre><code class="language-${escapeAttr(language)}">${escapedCode}</code></pre>` +
      `</div>`;

    storedBlocks.push(block);
    return `\x00CODE${idx}\x00`;
  });

  // ── 2. Inline code ────────────────────────────────────────────────────────
  html = html.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${escapeHtml(code as string)}</code>`);

  // ── 3. Bold / italic ──────────────────────────────────────────────────────
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  // ── 4. Headings ───────────────────────────────────────────────────────────
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // ── 5. Horizontal rules ───────────────────────────────────────────────────
  html = html.replace(/^(?:-{3,}|\*{3,}|_{3,})$/gm, '<hr>');

  // ── 6. Block quotes ───────────────────────────────────────────────────────
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // ── 7. Task lists (before regular lists) ─────────────────────────────────
  html = html.replace(
    /^[-*] \[x\] (.+)$/gim,
    '<li class="task-item checked"><input type="checkbox" disabled checked aria-checked="true"> $1</li>',
  );
  html = html.replace(
    /^[-*] \[ \] (.+)$/gim,
    '<li class="task-item"><input type="checkbox" disabled aria-checked="false"> $1</li>',
  );

  // ── 8. Unordered lists ───────────────────────────────────────────────────
  html = html.replace(/^[*\-•] (.+)$/gm, '<li>$1</li>');

  // ── 9. Ordered lists ─────────────────────────────────────────────────────
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, match => `<ul>${match}</ul>`);

  // ── 10. Links (no-href for safety) ───────────────────────────────────────
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<span class="md-link" title="$2">$1</span>',
  );

  // ── 11. Paragraphs ───────────────────────────────────────────────────────
  const BLOCK_TAGS = /^<(h[1-6]|ul|ol|li|hr|blockquote|pre|div)/;

  html = html
    .split(/\n{2,}/)
    .map(block => {
      block = block.trim();
      if (!block) {
        return '';
      }
      if (BLOCK_TAGS.test(block) || block.startsWith('\x00CODE')) {
        return block;
      }
      return `<p>${block}</p>`;
    })
    .join('\n');

  // Single newlines inside paragraphs → <br>
  html = html.replace(/([^>\n])\n(?=[^<\n])/g, '$1<br>');

  // ── 12. Restore code blocks ───────────────────────────────────────────────
  storedBlocks.forEach((block, idx) => {
    html = html.replace(`\x00CODE${idx}\x00`, block);
  });

  return html;
}
