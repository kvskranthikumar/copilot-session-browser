import * as assert from 'assert';
import { RedactorService } from '../../src/services/redactorService';

const svc = new RedactorService();

describe('RedactorService', () => {
  // ── PEM private keys ──────────────────────────────────────────────────────

  it('redacts RSA private key', () => {
    const input =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const { text, redactionCount } = svc.redact(input);
    assert.ok(!text.includes('MIIEpAIBAAKCAQEA'), 'Key content should be removed');
    assert.ok(text.includes('[REDACTED:PRIVATE_KEY]'));
    assert.ok(redactionCount >= 1);
  });

  // ── Bearer tokens ─────────────────────────────────────────────────────────

  it('redacts Bearer token in Authorization header', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI4ODgifQ.xyz';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('eyJhbGciOiJIUzI1Ni'));
    assert.ok(text.includes('[REDACTED:BEARER_TOKEN]'));
  });

  // ── AWS credentials ───────────────────────────────────────────────────────

  it('redacts AWS access key', () => {
    const input = 'Using access key AKIAIOSFODNN7EXAMPLE for auth';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), text);
    assert.ok(text.includes('[REDACTED:AWS_ACCESS_KEY]'));
  });

  it('redacts ASIA prefixed AWS key', () => {
    // ASIA + exactly 16 uppercase alphanumeric chars
    const input = 'key=ASIAIOSFODNN7ABCDEFG';
    const { text } = svc.redact(input);
    assert.ok(text.includes('[REDACTED:AWS_ACCESS_KEY]'), `Got: ${text}`);
  });

  // ── GitHub PAT ───────────────────────────────────────────────────────────

  it('redacts GitHub PAT starting with ghp_', () => {
    const input = 'Set GITHUB_TOKEN=ghp_1234567890abcdef1234567890abcdef1234';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('ghp_1234567890'), text);
    assert.ok(text.includes('[REDACTED:GH_PAT]'));
  });

  // ── Generic API key ───────────────────────────────────────────────────────

  it('redacts api_key in assignment', () => {
    const input = 'apiKey="abcdef1234567890abcdef1234567890"';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('abcdef1234567890abcdef1234567890'), text);
  });

  // ── URL passwords ─────────────────────────────────────────────────────────

  it('redacts password in URL', () => {
    const input = 'Connect to mongodb://admin:supersecretpassword@localhost:27017/db';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('supersecretpassword'), text);
    assert.ok(text.includes('[REDACTED:PASSWORD]'));
  });

  it('redacts password in connection string', () => {
    const input = 'Server=localhost;Database=mydb;User=admin;Password=MyP@ssw0rd!;';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('MyP@ssw0rd!'), text);
    assert.ok(text.includes('[REDACTED:PASSWORD]'));
  });

  // ── Azure ─────────────────────────────────────────────────────────────────

  it('redacts Azure storage account key', () => {
    const input =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123def456ghi789jkl012mno345pqr678stu901vwx234+a==;EndpointSuffix=core.windows.net';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('abc123def456'), text);
    assert.ok(text.includes('[REDACTED:AZURE_ACCOUNTKEY]'));
  });

  // ── maybeRedact ───────────────────────────────────────────────────────────

  it('maybeRedact passes through when disabled', () => {
    const secret = 'password=topsecret123!';
    const { text, redactionCount } = svc.maybeRedact(secret, false);
    assert.strictEqual(text, secret);
    assert.strictEqual(redactionCount, 0);
  });

  it('maybeRedact redacts when enabled', () => {
    const secret = 'password=topsecretpassword123!';
    const { text, redactionCount } = svc.maybeRedact(secret, true);
    assert.ok(!text.includes('topsecretpassword123'));
    assert.ok(redactionCount >= 1);
  });

  // ── File path redaction ───────────────────────────────────────────────────

  it('redacts Windows absolute paths', () => {
    const input = 'Config at C:\\Users\\john\\AppData\\Roaming\\app\\config.json';
    const result = svc.redactFilePaths(input);
    assert.ok(!result.includes('C:\\Users\\john'), result);
    assert.ok(result.includes('[REDACTED:PATH]'));
  });

  it('redacts POSIX home paths', () => {
    const input = 'Config at /home/alice/.config/app.json';
    const result = svc.redactFilePaths(input);
    assert.ok(!result.includes('/home/alice'), result);
    assert.ok(result.includes('[REDACTED:PATH]'));
  });

  // ── Safe text unchanged ───────────────────────────────────────────────────

  it('leaves normal text untouched', () => {
    const input = 'Use parseInt() to convert strings to numbers.';
    const { text, redactionCount } = svc.redact(input);
    assert.strictEqual(text, input);
    assert.strictEqual(redactionCount, 0);
  });

  it('leaves short identifiers untouched', () => {
    const input = 'Set env var MY_VAR=hello';
    const { text } = svc.redact(input);
    assert.ok(!text.includes('[REDACTED'));
  });

  // ── rulesApplied reporting ────────────────────────────────────────────────

  it('reports which rules were applied', () => {
    const input = 'key: AKIAIOSFODNN7EXAMPLE';
    const { rulesApplied } = svc.redact(input);
    assert.ok(rulesApplied.some(r => r.toLowerCase().includes('aws')));
  });
});
