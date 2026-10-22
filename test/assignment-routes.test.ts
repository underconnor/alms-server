import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const session = { user: { id: 'synthetic-owner' }, tokenHash: 'synthetic' }, headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
test('assignment list and detail are authenticated reads with numeric bound paths and an explicit refresh option only', async () => {
  const calls: unknown[] = [];
  const app = await buildApp(config, { getSession: async () => session } as unknown as Store, { ...unavailableSchoolProvider,
    assignments: async (context, courseId, options) => { calls.push({ context, courseId, refresh: options.refresh }); return assignmentListFixture(); },
    assignment: async (context, courseId, id, options) => { calls.push({ context, courseId, id, refresh: options.refresh }); return assignmentFixture(); },
  });
  try {
    for (const path of ['/v1/courses/10/assignments', '/v1/courses/10/assignments/90']) {
      assert.equal((await app.inject(path)).statusCode, 401);
      for (const query of ['?userId=other','?url=https://private.test','?refresh=0','?refresh=1&refresh=1'])
        assert.equal((await app.inject({ url: path + query, headers })).statusCode, 400);
      const response = await app.inject({ url: path + '?refresh=1', headers });
      assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal((await app.inject({ method: 'POST', url: path, headers })).statusCode, 404);
    }
    assert.equal(calls.length, 2); assert.deepEqual(calls, [{ context: { userId: 'synthetic-owner' }, courseId: '10', refresh: true },
      { context: { userId: 'synthetic-owner' }, courseId: '10', id: '90', refresh: true }]);
    assert.equal((await app.inject({ url: '/v1/courses/other/assignments/90', headers })).statusCode, 400);
  } finally { await app.close(); }
});
test('unavailable assignment providers and session revocation never become an empty list or submission success', async () => {
  for (const mode of ['missing','logout']) {
    let active = true;
    const app = await buildApp(config, { getSession: async () => active ? session : null } as unknown as Store, {
      ...unavailableSchoolProvider, ...(mode === 'logout' ? { assignment: async () => { active = false; return assignmentFixture(); } } : {}),
    });
    try { const response = await app.inject({ url: '/v1/courses/10/assignments/90', headers });
      assert.equal(response.statusCode, mode === 'missing' ? 503 : 401); assert.equal(response.json().submission, undefined);
    } finally { await app.close(); }
  }
});
test('assignment deadline also bounds a stalled final ALMS authorization query', async t => {
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  let checks = 0;
  const app = await buildApp(config, { getSession: async () => ++checks === 3 ? new Promise(() => {}) : session } as unknown as Store,
    { ...unavailableSchoolProvider, assignment: async () => assignmentFixture() });
  const alive = setTimeout(() => {}, 100);
  try { const response = await app.inject({ url: '/v1/courses/10/assignments/90', headers });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'ASSIGNMENTS_UNAVAILABLE');
  } finally { clearTimeout(alive); await app.close(); }
});
