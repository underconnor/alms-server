import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { apiDiscovery } from '../src/api-discovery.js';

test('public discovery distinguishes browser HTTP client from school SDK and disabled MCP', async () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
  const app = await buildApp(config, {} as Store);
  try {
    const result = await app.inject('/.well-known/alms-api');
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(result.json(), apiDiscovery(config));
    assert.equal(result.json().mcp.enabled, false);
    assert.equal((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode, 404);
    assert.equal(result.body.includes('encryption'), false);
    assert.equal(result.body.includes('FRONTEND_CLIENTS'), false);
  } finally { await app.close(); }
});
