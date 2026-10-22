import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { loadMcpConfig, mcpNativeRedirectUris } from '../src/mcp-config.js';

const encryptionKey = randomBytes(32);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...privateKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const valid = { MCP_ENABLED: 'true', MCP_SIGNING_JWKS_JSON: JSON.stringify({ keys: [key] }), MCP_COOKIE_KEYS_JSON: JSON.stringify([randomBytes(48).toString('base64url')]) };

test('MCP remains disabled by default and derives one exact issuer/resource when enabled', () => {
  assert.equal(loadMcpConfig({}, 'https://api.example.test'), undefined);
  assert.equal(loadMcpConfig({ MCP_ENABLED: 'false' }, 'https://api.example.test'), undefined);
  const config = loadMcpConfig(valid, 'https://api.example.test', encryptionKey)!;
  assert.equal(config.issuer, 'https://api.example.test/oauth');
  assert.equal(config.resource, 'https://api.example.test/mcp');
  assert.deepEqual(config.client.redirectUris, ['http://127.0.0.1/callback', 'http://localhost/callback',
    'http://127.0.0.1/callback/4WxPlX5X3kcy', 'http://localhost/callback/4WxPlX5X3kcy']);
});

test('Codex loopback callbacks are bound to the exact canonical resource URL without a wildcard', () => {
  assert.deepEqual(mcpNativeRedirectUris('https://api-lms.flyjung.kr/mcp'), ['http://127.0.0.1/callback', 'http://localhost/callback',
    'http://127.0.0.1/callback/mCKDGNpl4J3j', 'http://localhost/callback/mCKDGNpl4J3j']);
  assert.deepEqual(mcpNativeRedirectUris('http://127.0.0.1:4300/mcp'), ['http://127.0.0.1/callback', 'http://localhost/callback',
    'http://127.0.0.1/callback/xMAw8DYbtWUt', 'http://localhost/callback/xMAw8DYbtWUt']);
});

test('MCP fails closed without stable keys, encryption, valid signing key or safe origin', () => {
  assert.throws(() => loadMcpConfig({ MCP_ENABLED: 'yes' }, 'https://api.example.test'));
  assert.throws(() => loadMcpConfig(valid, 'https://api.example.test'));
  assert.throws(() => loadMcpConfig({ MCP_ENABLED: 'true' }, 'https://api.example.test', encryptionKey));
  assert.throws(() => loadMcpConfig(valid, 'http://example.test', encryptionKey));
  for (const value of ['{"keys":[]}', JSON.stringify({ keys: [{ ...key, d: undefined }] }), JSON.stringify({ keys: [key, key] })]) {
    assert.throws(() => loadMcpConfig({ ...valid, MCP_SIGNING_JWKS_JSON: value }, 'https://api.example.test', encryptionKey));
  }
  assert.throws(() => loadMcpConfig({ ...valid, MCP_COOKIE_KEYS_JSON: '["weak"]' }, 'https://api.example.test', encryptionKey));
  assert.ok(loadMcpConfig(valid, 'http://127.0.0.1:4300', encryptionKey));
});
