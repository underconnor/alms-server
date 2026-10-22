import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const bytes = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF');

test('syllabus metadata and PDF require same owner, exact query and private no-store responses', async () => {
  const calls: unknown[] = [];
  const store = { getSession: async () => ({ user: { id: 'owner' }, tokenHash: 'hash' }) } as unknown as Store;
  const app = await buildApp(config, store, { ...unavailableSchoolProvider,
    syllabus: async (context, courseId, options) => { await options.validate(); calls.push({ context, courseId, refresh: options.refresh }); return { courseId, documentAvailable: true, documentVersion: 'a'.repeat(64) }; },
    syllabusMaterial: async (context, courseId, options) => { await options.validate(); calls.push({ context, courseId, refresh: options.refresh }); return { bytes }; },
  });
  try {
    for (const path of ['/v1/courses/7001/syllabus', '/v1/courses/7001/syllabus/material']) {
      assert.equal((await app.inject(path)).statusCode, 401);
      for (const query of ['owner=other', 'refresh=0', 'refresh=1&refresh=1', 'url=https://evil.test'])
        assert.equal((await app.inject({ url: path + '?' + query, headers })).statusCode, 400);
      const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], path.endsWith('/material') ? 'private, no-store' : 'no-store');
      if (path.endsWith('/material')) {
        assert.deepEqual(response.rawPayload, bytes); assert.equal(response.headers['content-type'], 'application/pdf');
        assert.equal(response.headers['content-length'], String(bytes.length)); assert.equal(response.headers['accept-ranges'], 'none');
        assert.match(response.headers['content-disposition']!, /syllabus.pdf/);
      }
    }
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ context: { userId: 'owner' }, courseId: '7001', refresh: undefined })));
    assert.equal((await app.inject({ url: '/v1/courses/7001/syllabus/material?refresh=1', headers })).statusCode, 200);
    assert.equal((calls[2] as any).refresh, true);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/courses/7001/syllabus', headers })).statusCode, 404);
  } finally { await app.close(); }
});
test('revocation during syllabus preparation withholds both metadata and bytes', async () => {
  for (const material of [true, false]) {
    let active = true;
    const store = { getSession: async () => active ? { user: { id: 'owner' }, tokenHash: 'hash' } : null } as unknown as Store;
    const app = await buildApp(config, store, { ...unavailableSchoolProvider,
      syllabus: async () => { active = false; return { secret: 'never-return' }; },
      syllabusMaterial: async () => { active = false; return { bytes }; },
    });
    try {
      const response = await app.inject({ url: '/v1/courses/7001/syllabus' + (material ? '/material' : ''), headers });
      assert.equal(response.statusCode, 401); assert.doesNotMatch(response.body, /never-return|PDF/);
    } finally { await app.close(); }
  }
});
test('unconfigured syllabus stays unavailable instead of claiming an empty document', async () => {
  const store = { getSession: async () => ({ user: { id: 'owner' } }) } as unknown as Store;
  const app = await buildApp(config, store);
  try {
    for (const path of ['/v1/courses/7001/syllabus', '/v1/courses/7001/syllabus/material']) {
      const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'SYLLABUS_UNAVAILABLE'); assert.doesNotMatch(response.body, /documentAvailable/);
    }
  } finally { await app.close(); }
});
