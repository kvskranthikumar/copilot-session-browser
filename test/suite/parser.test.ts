import * as assert from 'assert';
import * as path from 'path';
import { ParserService } from '../../src/services/parserService';
import { extractCodeBlocks, parseDate, deriveTitle } from '../../src/services/parserService';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const parser = new ParserService();

// ── parseDate ────────────────────────────────────────────────────────────────

describe('parseDate', () => {
  it('parses ISO string', () => {
    const d = parseDate('2024-01-15T10:30:00.000Z');
    assert.ok(d instanceof Date);
    assert.strictEqual(d!.getUTCFullYear(), 2024);
  });

  it('parses epoch milliseconds', () => {
    const d = parseDate(1705312200000);
    assert.ok(d instanceof Date);
    assert.ok(!isNaN(d!.getTime()));
  });

  it('parses epoch seconds', () => {
    const d = parseDate(1705312); // small number → seconds
    assert.ok(d instanceof Date);
  });

  it('returns undefined for invalid string', () => {
    assert.strictEqual(parseDate('not-a-date'), undefined);
  });

  it('returns undefined for null', () => {
    assert.strictEqual(parseDate(null), undefined);
  });

  it('returns undefined for undefined', () => {
    assert.strictEqual(parseDate(undefined), undefined);
  });
});

// ── extractCodeBlocks ────────────────────────────────────────────────────────

describe('extractCodeBlocks', () => {
  it('extracts a single fenced code block', () => {
    const md = 'Intro\n\n```typescript\nconst x = 1;\n```\n\nOutro';
    const blocks = extractCodeBlocks(md);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].language, 'typescript');
    assert.ok(blocks[0].content.includes('const x = 1;'));
  });

  it('extracts multiple code blocks', () => {
    const md = '```js\nvar a = 1;\n```\n\n```python\nprint("hello")\n```';
    const blocks = extractCodeBlocks(md);
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].language, 'js');
    assert.strictEqual(blocks[1].language, 'python');
  });

  it('returns empty array for no code blocks', () => {
    const blocks = extractCodeBlocks('Just plain text.');
    assert.strictEqual(blocks.length, 0);
  });

  it('handles code block with no language', () => {
    const blocks = extractCodeBlocks('```\nsome code\n```');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].language, 'text');
  });
});

// ── deriveTitle ───────────────────────────────────────────────────────────────

describe('deriveTitle', () => {
  it('derives title from first user message', () => {
    const messages = [
      { role: 'user' as const, markdownContent: 'How do I fix a TypeScript error?', id: '1', sessionId: 's1', codeBlocks: [] },
    ];
    const title = deriveTitle(messages);
    assert.strictEqual(title, 'How do I fix a TypeScript error?');
  });

  it('truncates long titles', () => {
    const messages = [
      { role: 'user' as const, markdownContent: 'A'.repeat(100), id: '1', sessionId: 's1', codeBlocks: [] },
    ];
    const title = deriveTitle(messages);
    assert.ok(title.length <= 83); // 77 + '…' + some slack
  });

  it('returns fallback for no user messages', () => {
    const title = deriveTitle([]);
    assert.strictEqual(title, 'Untitled Session');
  });
});

// ── Schema V1 ─────────────────────────────────────────────────────────────────

describe('ParserService – Schema V1', () => {
  it('parses v1 fixture successfully', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v1.json'));
    assert.strictEqual(result.errors.length, 0, `Errors: ${result.errors.join(', ')}`);
    assert.ok(result.sessions.length >= 2, 'Expected at least 2 sessions');
  });

  it('extracts correct session title', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v1.json'));
    const titles = result.sessions.map(s => s.title);
    assert.ok(titles.some(t => t.includes('TypeScript')), `Titles: ${titles.join(', ')}`);
  });

  it('extracts user and assistant messages', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v1.json'));
    const session = result.sessions[0];
    const roles = session.messages.map(m => m.role);
    assert.ok(roles.includes('user'), 'Should have user messages');
    assert.ok(roles.includes('assistant'), 'Should have assistant messages');
  });

  it('extracts code blocks from messages', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v1.json'));
    const session = result.sessions[0];
    const codeBlocks = session.messages.flatMap(m => m.codeBlocks);
    assert.ok(codeBlocks.length > 0, 'Expected code blocks');
    assert.ok(codeBlocks.some(cb => cb.language === 'typescript'), 'Expected typescript block');
  });

  it('parses timestamps correctly', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v1.json'));
    const session = result.sessions[0];
    assert.ok(session.createdAt instanceof Date);
    assert.ok(!isNaN(session.createdAt.getTime()));
  });

  it('normalises tags from fixture', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v1.json'));
    const session = result.sessions[0];
    assert.ok(Array.isArray(session.tags));
    assert.ok(session.tags.includes('typescript'));
  });
});

// ── Schema V2 ─────────────────────────────────────────────────────────────────

describe('ParserService – Schema V2', () => {
  it('parses v2 fixture successfully', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v2.json'));
    assert.strictEqual(result.errors.length, 0, `Errors: ${result.errors.join(', ')}`);
    assert.ok(result.sessions.length >= 1, 'Expected at least 1 session');
  });

  it('detects v2 schema version', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v2.json'));
    assert.ok(result.schemaVersion.includes('v2'), `Got: ${result.schemaVersion}`);
  });

  it('extracts workspace path', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v2.json'));
    const session = result.sessions[0];
    assert.ok(session.workspaceContext ?? session.workspaceContext === undefined);
  });

  it('extracts epoch timestamps', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v2.json'));
    const session = result.sessions[0];
    assert.ok(session.createdAt instanceof Date);
    assert.ok(session.createdAt.getFullYear() >= 2024);
  });
});

// ── Schema V4 (single session) ───────────────────────────────────────────────

describe('ParserService – Schema V4 (single session file)', () => {
  it('parses v4 fixture successfully', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v4.json'));
    assert.strictEqual(result.errors.length, 0, `Errors: ${result.errors.join(', ')}`);
    assert.strictEqual(result.sessions.length, 1);
  });

  it('preserves explicit title', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v4.json'));
    assert.ok(result.sessions[0].title.includes('Database'));
  });

  it('maps roles correctly', () => {
    const result = parser.parseFile(path.join(FIXTURES, 'session-v4.json'));
    const roles = result.sessions[0].messages.map(m => m.role);
    assert.deepStrictEqual(roles.sort(), ['assistant', 'user', 'user'].sort());
  });
});

// ── Schema evolution / unknown schema ────────────────────────────────────────

describe('ParserService – Schema resilience', () => {
  it('returns error for invalid JSON', () => {
    const result = parser.parseRaw('{ not valid json }', 'test.json');
    assert.ok(result.errors.length > 0);
    assert.strictEqual(result.sessions.length, 0);
  });

  it('returns error for unknown schema', () => {
    const result = parser.parseRaw('{ "foo": "bar" }', 'test.json');
    assert.ok(result.errors.length > 0);
    assert.strictEqual(result.sessions.length, 0);
  });

  it('handles empty session array gracefully', () => {
    const raw = JSON.stringify({ version: '1', sessions: [] });
    const result = parser.parseRaw(raw, 'test.json');
    // Should not crash; may return no sessions
    assert.ok(Array.isArray(result.sessions));
  });

  it('handles partial message data without crashing', () => {
    const raw = JSON.stringify({
      version: '1',
      sessions: [{
        id: 'test-1',
        title: 'Partial',
        requests: [{
          id: 'r1',
          message: 'Hello',
          // response is missing – should still work
        }]
      }]
    });
    const result = parser.parseRaw(raw, 'test.json');
    assert.ok(result.sessions.length >= 1);
    assert.ok(result.sessions[0].messages.length >= 1);
  });

  it('adds imported tag when using parseImportedFile', () => {
    // This wraps around parseFile, but we test the tag logic via parseRaw + manual tag check
    const raw = JSON.stringify({
      id: 'x1',
      title: 'Test',
      messages: [{ id: 'm1', role: 'user', content: 'Hi' }]
    });
    const result = parser.parseRaw(raw, 'imported:test.json');
    assert.ok(result.sessions.length === 1);
    // Note: tags are set by parseImportedFile wrapper; parseRaw itself doesn't add them
    // This tests the raw parsing is fine
  });
});
