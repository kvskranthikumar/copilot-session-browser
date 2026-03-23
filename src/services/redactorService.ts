/**
 * RedactorService — removes secrets and sensitive values from text
 * before it leaves the extension (summary, export, display).
 *
 * All patterns are applied sequentially and their replacement is visible
 * to the user so they know redaction occurred.
 */

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string) => string);
}

// ── Pattern library ───────────────────────────────────────────────────────────

const RULES: RedactionRule[] = [
  // PEM / SSH private keys
  {
    name: 'PEM private key',
    pattern: /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/gi,
    replacement: '[REDACTED:PRIVATE_KEY]',
  },
  // Generic Bearer / Authorization header values
  {
    name: 'Bearer token',
    pattern: /\b(Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9\-._~+/]{20,}/gi,
    replacement: '$1 [REDACTED:BEARER_TOKEN]',
  },
  // AWS access key
  {
    name: 'AWS access key',
    pattern: /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED:AWS_ACCESS_KEY]',
  },
  // AWS secret key (contextual heuristic)
  {
    name: 'AWS secret key',
    pattern: /(?:aws.?secret.?access.?key|aws.?secret)['"=:\s]+([A-Za-z0-9/+]{40})\b/gi,
    replacement: (matched: string) => matched.replace(/[A-Za-z0-9/+]{40}/, '[REDACTED:AWS_SECRET]'),
  },
  // Azure storage connection strings
  {
    name: 'Azure connection string',
    pattern: /AccountKey=[A-Za-z0-9+/]{44,88}={0,2}/gi,
    replacement: 'AccountKey=[REDACTED:AZURE_ACCOUNTKEY]',
  },
  // GitHub / GitLab personal access tokens
  {
    name: 'GitHub PAT',
    pattern: /\b(gh[ps]_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9]{20})\b/g,
    replacement: '[REDACTED:GH_PAT]',
  },
  // Generic API key patterns (key="…", apiKey:"…", api_key=…)
  {
    name: 'Generic API key',
    pattern: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)['"=:\s]+([A-Za-z0-9\-._~+/]{20,})/gi,
    replacement: (m: string) =>
      m.replace(/(['"=:\s]+)[A-Za-z0-9\-._~+/]{20,}/, '$1[REDACTED:API_KEY]'),
  },
  // Password in URLs / connection strings
  {
    name: 'URL password',
    pattern: /(:\/\/[^:]+:)[^@]+(@)/g,
    replacement: '$1[REDACTED:PASSWORD]$2',
  },
  // Database connection strings with passwords
  {
    name: 'DB password in connection string',
    pattern: /(?:password|pwd|passwd)\s*=\s*[^;,\s'"]{4,}/gi,
    replacement: (m: string) =>
      m.replace(/=\s*[^;,\s'"]{4,}/, '=[REDACTED:PASSWORD]'),
  },
  // Generic long random-looking tokens (≥40 chars with digits+upper+lower+special)
  {
    name: 'Generic long token',
    pattern: /\b(?=[A-Za-z0-9!@#$%^&*\-._+=]{40,})(?=\S*[A-Z])(?=\S*[a-z])(?=\S*\d)[A-Za-z0-9!@#$%^&*\-._+=]{40,}\b/g,
    replacement: '[REDACTED:SECRET_TOKEN]',
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

export interface RedactionResult {
  text: string;
  rulesApplied: string[];
  redactionCount: number;
}

export class RedactorService {
  /**
   * Redact secrets from arbitrary text.
   * Returns the cleaned text and metadata about what was removed.
   */
  redact(input: string): RedactionResult {
    let text = input;
    const rulesApplied: string[] = [];
    let redactionCount = 0;

    for (const rule of RULES) {
      const original = text;
      if (typeof rule.replacement === 'string') {
        text = text.replace(rule.pattern, rule.replacement);
      } else {
        const fn = rule.replacement as (match: string, ...args: string[]) => string;
        text = text.replace(rule.pattern, fn);
      }
      if (text !== original) {
        rulesApplied.push(rule.name);
        // Count occurrences (approximate – count [REDACTED placeholders introduced)
        const before = (original.match(/\[REDACTED:/g) || []).length;
        const after = (text.match(/\[REDACTED:/g) || []).length;
        redactionCount += after - before;
      }
    }

    return { text, rulesApplied, redactionCount };
  }

  /** Redact text only if enabled; otherwise return as-is with no redactions */
  maybeRedact(input: string, enabled: boolean): RedactionResult {
    if (!enabled) {
      return { text: input, rulesApplied: [], redactionCount: 0 };
    }
    return this.redact(input);
  }

  /**
   * Strip file-path references from text.
   * Removes absolute paths (Windows and POSIX) to reduce information leakage.
   */
  redactFilePaths(input: string): string {
    // Windows absolute paths: C:\... or \\server\...
    let text = input.replace(/[A-Za-z]:\\[^\s"'`<>|\r\n]*/g, '[REDACTED:PATH]');
    // UNC paths
    text = text.replace(/\\\\[^\s"'`<>|\r\n]*/g, '[REDACTED:PATH]');
    // POSIX absolute paths: /home/..., /usr/...
    text = text.replace(/\/(?:home|usr|var|etc|root|opt|mnt|srv|tmp)[^\s"'`<>|\r\n]*/g, '[REDACTED:PATH]');
    return text;
  }
}


