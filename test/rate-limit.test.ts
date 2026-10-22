import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';

test('rate limit returns the 429 contract and preserves health checks and other clients',async () => {
  const store = { health: async () => {} } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://synthetic.invalid/alms_test',LOG_LEVEL: 'silent' }),store);
  const remoteAddress = '192.0.2.10';
  try {
    for (let i=0;i<300;i++) {
      const response = await app.inject({ url: '/version',remoteAddress });
      assert.equal(response.statusCode,200);
    }

    const limited = await app.inject({ url: '/v1/auth/login',remoteAddress });
    assert.equal(limited.statusCode,429);
    assert.deepEqual(limited.json().error,{
      code: 'RATE_LIMITED',message: '잠시 후 다시 시도해 주세요.',requestId: limited.json().error.requestId,
    });
    assert.equal(typeof limited.json().error.requestId,'string');
    assert.ok(Number(limited.headers['retry-after'])>0);
    assert.equal(limited.headers['cache-control'],'no-store');

    // Untrusted forwarded headers must not let a direct caller evade its limit.
    const forged = await app.inject({ url: '/version',remoteAddress,headers: {
      'x-forwarded-for': '198.51.100.20','cf-connecting-ip': '198.51.100.20',
    } });
    assert.equal(forged.statusCode,429);
    assert.equal(forged.json().error.code,'RATE_LIMITED');

    for (const url of ['/healthz','/readyz']) {
      assert.equal((await app.inject({ url,remoteAddress })).statusCode,200);
    }
    const otherClient = await app.inject({ url: '/version',remoteAddress: '192.0.2.11' });
    assert.equal(otherClient.statusCode,200);
  } finally { await app.close(); }
});
