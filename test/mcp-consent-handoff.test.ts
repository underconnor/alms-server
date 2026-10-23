import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedMcpResumeUrl } from '../src/mcp-auth/handoff.js';
import { handoffHtml } from '../src/mcp-auth/html.js';

const origin = 'https://api.example.test', uid = 'a'.repeat(43), target = origin + '/oauth/auth/' + uid;

test('the handoff accepts only the provider-generated canonical same-origin resume URL and exact interaction', () => {
  assert.equal(verifiedMcpResumeUrl(target, origin, target), target);
  const invalid = [
    'https://evil.example/oauth/auth/' + uid, 'https://api.example.test.evil.example/oauth/auth/' + uid,
    'http://api.example.test/oauth/auth/' + uid, 'https://u@api.example.test/oauth/auth/' + uid,
    origin + '/oauth/auth/' + 'b'.repeat(43), origin + '/oauth/auth/' + uid + '/extra', target + '?next=evil', target + '#fragment',
    origin + '/oauth/auth/../auth/' + uid, origin + '/oauth/%61uth/' + uid, 'https://api.example.test:443/oauth/auth/' + uid,
    '/oauth/auth/' + uid, '//api.example.test/oauth/auth/' + uid, '\n' + target, 'javascript:alert(1)',
  ];
  for (const value of invalid) assert.throws(() => verifiedMcpResumeUrl(value, origin, target), { code: 'MCP_AUTH_REQUIRED' });
  for (const expected of [origin + '/unrelated/' + uid, 'https://evil.example/oauth/auth/' + uid, target + '?next=evil']) {
    assert.throws(() => verifiedMcpResumeUrl(expected, origin, expected), { code: 'MCP_AUTH_REQUIRED' });
  }
  assert.throws(() => verifiedMcpResumeUrl(target, origin + '/path', target), { code: 'MCP_AUTH_REQUIRED' });
});

test('the new document uses an immediate GET handoff and escaped fallback link without scripts or another form', () => {
  const html = handoffHtml(verifiedMcpResumeUrl(target, origin, target));
  assert.match(html, /^<!doctype html>/); assert.ok(html.indexOf('http-equiv="refresh"') < html.indexOf('</head>'));
  assert.ok(html.includes('<meta http-equiv="refresh" content="0;url=' + target + '">'));
  assert.ok(html.includes('<a href="' + target + '" rel="noreferrer">'));
  assert.doesNotMatch(html, /<script|<form|http-equiv="location"|javascript:/i);
  const escaped = handoffHtml('https://example.test/"/><script>private</script>&\'');
  assert.doesNotMatch(escaped, /<script>|\/"\/><script>/);
  assert.match(escaped, /&quot;/); assert.match(escaped, /&lt;script&gt;/); assert.match(escaped, /&amp;/); assert.match(escaped, /&#39;/);
});
