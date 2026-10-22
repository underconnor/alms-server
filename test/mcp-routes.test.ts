import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { AppError } from '../src/errors.js';
import { registerMcpRoutes } from '../src/mcp-routes.js';
import type { McpPrincipal, McpReadTools } from '../src/mcp-types.js';

const apiOrigin = 'https://api.alms.example';
const resource = `${apiOrigin}/mcp`;
const issuer = `${apiOrigin}/mcp-oauth`;
const host = new URL(apiOrigin).host;
const metadataUrl = `${apiOrigin}/.well-known/oauth-protected-resource/mcp`;
const modern = '2026-07-28';
const legacy = '2025-11-25';

interface RecordedCall {
  name: string;
  args: unknown;
  principal: McpPrincipal;
  signal: AbortSignal;
}

async function fixture() {
  const calls: RecordedCall[] = [];
  const authTokens: string[] = [];
  const validations: string[] = [];
  let revoked = false;
  let aborted = false;
  const principal = (id: string, scopes: readonly string[] = ['alms:read']): McpPrincipal => ({
    userId: id,
    authorizationId: `private-grant-${id}`,
    sessionTokenHash: `private-session-${id}`,
    scopes,
    async validate() {
      validations.push(id);
      if (revoked) throw new AppError(401, 'MCP_AUTH_EXPIRED', '연결 승인이 만료됐습니다.');
    },
  });
  const principals = new Map([
    ['owner-a-token', principal('owner-a')],
    ['owner-b-token', principal('owner-b')],
    ['wrong-scope-token', principal('owner-c', ['profile:read'])],
  ]);
  const tools: McpReadTools = {
    listToolDefinitions: () => [{
      name: 'alms_read_fixture', description: 'Read a synthetic authorized item.',
      inputSchema: {
        type: 'object', properties: { itemId: { type: 'string', pattern: '^[0-9]+$' }, wait: { type: 'boolean' } },
        required: ['itemId'], additionalProperties: false,
      },
      outputSchema: {
        type: 'object', properties: { itemId: { type: 'string' }, marker: { type: 'string' } },
        required: ['itemId', 'marker'], additionalProperties: false,
      },
    }],
    async call(name, args, auth, { signal }) {
      calls.push({ name, args, principal: auth, signal });
      const input = args as { itemId: string; wait?: boolean };
      if (input.wait) {
        await new Promise<void>((resolve) => {
          const finish = () => { aborted = true; resolve(); };
          if (signal.aborted) finish();
          else signal.addEventListener('abort', finish, { once: true });
        });
      }
      const output = { itemId: input.itemId, marker: auth.userId === 'owner-a' ? 'A' : 'B' };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    },
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof AppError;
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    return reply.code(known ? error.statusCode : frameworkStatus ?? 500).send({ error: { code: known ? error.code : 'INTERNAL' } });
  });
  await registerMcpRoutes(app, {
    apiOrigin, resource, issuer, allowedOrigins: ['https://lms.alms.example'], version: '0.0.0-test', tools,
    async authenticate(token) {
      authTokens.push(token);
      const found = principals.get(token);
      if (!found) throw new AppError(401, 'MCP_AUTH_EXPIRED', '연결 승인이 만료됐습니다.');
      return found;
    },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  async function send(path: string, body?: unknown, patch: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    // A real TCP request lets the test exercise the production Host check.
    // Node fetch may replace an explicitly supplied Host header.
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(`${address}${path}`, {
        method: patch.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          host, accept: 'application/json, text/event-stream',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...patch.headers,
        },
        ...(patch.signal ? { signal: patch.signal } : {}),
      }, res => {
        const resultHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) resultHeaders.append(name, item);
        }
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
          status: res.statusCode!, headers: resultHeaders,
        }));
      });
      req.once('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { app, calls, authTokens, validations, principals, send,
    revoke: () => { revoked = true; }, wasAborted: () => aborted };
}

function rpc(method: string, params: Record<string, unknown>, version = legacy) {
  return {
    jsonrpc: '2.0', id: 7, method,
    params: version === modern ? { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': modern,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'alms-transport-test', version: '0' },
    } } : params,
  };
}

function headers(method: string, version = legacy, token = 'owner-a-token', name?: string) {
  return {
    authorization: `Bearer ${token}`, 'mcp-protocol-version': version,
    ...(version === modern ? { 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) } : {}),
  };
}

async function readRpc(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()));
    const result = data.find(item => item.id === 7);
    assert.ok(result, 'SSE stream must contain the final JSON-RPC response');
    return result;
  }
  return JSON.parse(text);
}

test('MCP protected-resource metadata is discoverable without a user or school read', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await f.send(path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource, authorization_servers: [issuer], scopes_supported: ['alms:read'],
      bearer_methods_supported: ['header'], resource_name: 'ALMS 조회 전용 MCP',
    });
  }
  assert.equal(f.authTokens.length, 0); assert.equal(f.calls.length, 0);
});

for (const version of ['2025-06-18', legacy, modern]) {
  test(`real HTTP MCP ${version} discovers and calls only the read-only schema`, async t => {
    const f = await fixture(); t.after(() => f.app.close());
    const first = version === modern ? 'server/discover' : 'initialize';
    const params = version === modern ? {} : {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'alms-transport-test', version: '0' },
    };
    const discovery = await f.send('/mcp', rpc(first, params, version), { headers: headers(first, version) });
    assert.equal(discovery.status, 200);
    assert.equal(discovery.headers.has('mcp-session-id'), false);
    assert.equal((await readRpc(discovery)).error, undefined);
    const list = await f.send('/mcp', rpc('tools/list', {}, version), { headers: headers('tools/list', version) });
    assert.equal(list.status, 200);
    const definition = (await readRpc(list)).result.tools[0];
    assert.equal(definition.name, 'alms_read_fixture');
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.annotations.destructiveHint, false);
    const call = await f.send('/mcp', rpc('tools/call', { name: 'alms_read_fixture', arguments: { itemId: '42' } }, version), {
      headers: headers('tools/call', version, 'owner-a-token', 'alms_read_fixture'),
    });
    assert.equal(call.status, 200);
    assert.equal(call.headers.get('cache-control'), 'no-store');
    assert.equal(call.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual((await readRpc(call)).result.structuredContent, { itemId: '42', marker: 'A' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.principal, f.principals.get('owner-a-token'));
    assert.equal(f.calls[0]!.signal instanceof AbortSignal, true);
  });
}

test('cookie-only, malformed and unknown bearer requests return discovery challenges before any tool read', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const patch of [{ cookie: 'alms_session=existing-browser-session' }, { authorization: 'Basic abc' },
    { authorization: 'Bearer a token with spaces' }, { authorization: 'Bearer unknown-token' }]) {
    const response = await f.send('/mcp', rpc('tools/list', {}), { headers: patch });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
    assert.ok(response.headers.get('www-authenticate')?.includes(`resource_metadata="${metadataUrl}"`));
    assert.equal((await response.json() as any).error.code.startsWith('MCP_'), true);
  }
  assert.deepEqual(f.authTokens, ['unknown-token']); assert.equal(f.calls.length, 0);
});

test('insufficient scope and a subsequently revoked grant are checked on every HTTP request', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const wrong = await f.send('/mcp', rpc('tools/list', {}), { headers: headers('tools/list', legacy, 'wrong-scope-token') });
  assert.equal(wrong.status, 403);
  assert.match(wrong.headers.get('www-authenticate') ?? '', /insufficient_scope/);
  await wrong.text();
  const first = await f.send('/mcp', rpc('tools/list', {}), { headers: headers('tools/list') });
  assert.equal(first.status, 200); await readRpc(first);
  f.revoke();
  const next = await f.send('/mcp', rpc('tools/call', { name: 'alms_read_fixture', arguments: { itemId: '42' } }), {
    headers: headers('tools/call'),
  });
  assert.equal(next.status, 401); await next.text();
  assert.deepEqual(f.validations, ['owner-c', 'owner-a', 'owner-a']); assert.equal(f.calls.length, 0);
});

test('concurrent callers keep the immutable principal from their own authenticated request', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const results = await Promise.all(['owner-a-token', 'owner-b-token'].map(async token => {
    const response = await f.send('/mcp', rpc('tools/call', { name: 'alms_read_fixture', arguments: { itemId: '42' } }), {
      headers: headers('tools/call', legacy, token),
    });
    assert.equal(response.status, 200);
    return (await readRpc(response)).result.structuredContent;
  }));
  assert.deepEqual(results, [{ itemId: '42', marker: 'A' }, { itemId: '42', marker: 'B' }]);
  assert.deepEqual(f.calls.map(call => call.principal.userId).sort(), ['owner-a', 'owner-b']);
});

test('untrusted owner, token and URL arguments and mutation tool names never reach the read provider', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const arguments_ of [{ itemId: '42', userId: 'owner-b' }, { itemId: '42', token: 'private' },
    { itemId: '42', url: 'https://example.invalid' }, { itemId: '../42' }]) {
    const response = await f.send('/mcp', rpc('tools/call', { name: 'alms_read_fixture', arguments: arguments_ }), {
      headers: headers('tools/call'),
    });
    assert.equal(response.status, 200);
    const body = await readRpc(response);
    assert.ok(body.error || body.result?.isError, 'schema validation must fail closed');
  }
  for (const name of ['alms_submit_assignment', 'alms_start_playback', 'alms_record_progress', 'alms_set_completion']) {
    const response = await f.send('/mcp', rpc('tools/call', { name, arguments: {} }), { headers: headers('tools/call') });
    assert.equal(response.status, 200);
    const body = await readRpc(response);
    assert.ok(body.error || body.result?.isError, 'unregistered mutations must not execute');
  }
  assert.equal(f.calls.length, 0);
});

test('invalid Host and Origin fail before token verification; an allowed browser origin remains usable', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const extra of [{ host: 'attacker.example' }, { origin: 'https://evil.example' }, { origin: 'null' },
    { origin: 'https://lms.alms.example.evil.example' }]) {
    const response = await f.send('/mcp', rpc('tools/list', {}), { headers: { ...headers('tools/list'), ...extra } });
    assert.equal(response.status, 403); await response.text();
  }
  assert.equal(f.authTokens.length, 0);
  const response = await f.send('/mcp', rpc('tools/list', {}), { headers: { ...headers('tools/list'), origin: 'https://lms.alms.example' } });
  assert.equal(response.status, 200); await readRpc(response);
  assert.equal(f.authTokens.length, 1);
});

test('stateless HTTP declines GET/DELETE and does not retain a protocol session', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const method of ['GET', 'DELETE']) {
    const response = await f.send('/mcp', undefined, { method, headers: { authorization: 'Bearer owner-a-token' } });
    assert.equal(response.status, 405); assert.equal(response.headers.has('mcp-session-id'), false); await response.text();
  }
  assert.equal(f.calls.length, 0);
});

test('the Fastify parser enforces the MCP body bound before token verification', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const response = await f.send('/mcp', rpc('tools/call', {
    name: 'alms_read_fixture', arguments: { itemId: '42', padding: 'x'.repeat(33 * 1024) },
  }), { headers: headers('tools/call') });
  assert.equal(response.status, 413); await response.text();
  assert.equal(f.authTokens.length, 0); assert.equal(f.calls.length, 0);
});

test('real client disconnect aborts the signal delivered to the in-flight read provider', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const controller = new AbortController();
  const pending = f.send('/mcp', rpc('tools/call', { name: 'alms_read_fixture', arguments: { itemId: '42', wait: true } }), {
    headers: headers('tools/call'), signal: controller.signal,
  });
  for (let i = 0; i < 100 && f.calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
  controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  for (let i = 0; i < 100 && !f.wasAborted(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.wasAborted(), true);
});

test('the in-flight request budget rejects excess work before authentication and is released after disconnect', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const pending = controllers.map(controller => f.send('/mcp', rpc('tools/call', {
    name: 'alms_read_fixture', arguments: { itemId: '42', wait: true },
  }), { headers: headers('tools/call'), signal: controller.signal }).then(
    response => response.text(),
    error => { assert.equal((error as Error).name, 'AbortError'); },
  ));
  try {
    for (let i = 0; i < 200 && f.calls.length < 32; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.length, 32);
    const extra = await f.send('/mcp', rpc('tools/list', {}), { headers: headers('tools/list') });
    assert.equal(extra.status, 429); await extra.text();
    assert.equal(f.authTokens.length, 32);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.all(pending);
  }
  // The async provider finishes after it receives the socket-close cancellation.
  for (let i = 0; i < 200 && f.calls.some(call => !call.signal.aborted); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.every(call => call.signal.aborted), true);
  const next = await f.send('/mcp', rpc('tools/list', {}), { headers: headers('tools/list') });
  assert.equal(next.status, 200); await readRpc(next);
  assert.equal(f.authTokens.length, 33);
});
