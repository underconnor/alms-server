import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { AppError } from '../src/errors.js';
const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
const url = '/v1/calendar?start=2099-10-01&end=2099-11-01';
const data = { start: '2099-10-01', end: '2099-11-01', timeZone: 'Asia/Seoul' as const, courses: [], items: [], complete: true as const };
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const session = { user: { id: 'synthetic-owner' }, tokenHash: 'synthetic' };
test('calendar GET validates the range and filters and uses only the authenticated owner', async () => {
  const calls: unknown[] = [];
  const app = await buildApp(config, { getSession: async () => session } as unknown as Store, {
    ...unavailableSchoolProvider, calendar: async (context, query, options) => { await options.validate(); calls.push({ context, query }); return data; },
  });
  try {
    assert.equal((await app.inject(url)).statusCode, 401);
    for (const query of ['&userId=other','&courseId=10&courseId=20','&courseId=../1','&start=2099-10-01','&refresh=0','&refresh=1&refresh=1'])
      assert.equal((await app.inject({ url: url + query, headers })).statusCode, 400);
    assert.equal(calls.length, 0);
    const response = await app.inject({ url: url + '&courseId=10', headers });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), data);
    assert.deepEqual(calls, [{ context: { userId: 'synthetic-owner' }, query: { start: data.start, end: data.end, courseId: '10' } }]);
  } finally { await app.close(); }
});
test('explicit calendar refresh is passed as a read option and never added to the school range query', async () => {
  let called = false;
  const app = await buildApp(config, { getSession: async () => session } as unknown as Store, { ...unavailableSchoolProvider,
    calendar: async (_context, query, options) => { called = true; assert.equal(options.refresh, true); assert.deepEqual(query, { start: data.start, end: data.end }); return data; },
  });
  try { assert.equal((await app.inject({ url: url + '&refresh=1', headers })).statusCode, 200); assert.equal(called, true); }
  finally { await app.close(); }
});
test('unsupported calendar, upstream failure and revoked session stay distinct from a verified empty month', async () => {
  for (const mode of ['missing','401','502','503','logout'] as const) {
    let active = true;
    const app = await buildApp(config, { getSession: async () => active ? session : null } as unknown as Store, {
      ...unavailableSchoolProvider, ...(mode !== 'missing' ? { calendar: async () => {
        if (mode === 'logout') { active = false; return data; }
        throw new AppError(Number(mode), mode === '401' ? 'AUTH_REQUIRED' : 'CALENDAR_UNAVAILABLE', '합성 오류');
      } } : {}),
    });
    try {
      const response = await app.inject({ url, headers });
      assert.equal(response.statusCode, mode === 'missing' ? 503 : mode === 'logout' ? 401 : Number(mode));
      assert.equal(response.json().items, undefined);
    } finally { await app.close(); }
  }
});
test('calendar timeout bounds a hanging final ALMS session check and withholds a successful payload', async t => {
  const timeout = AbortSignal.timeout; let checks = 0;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  const app = await buildApp(config, { getSession: async () => ++checks === 3 ? new Promise(() => {}) : session } as unknown as Store, {
    ...unavailableSchoolProvider, calendar: async () => data,
  });
  const alive = setTimeout(() => {}, 100);
  try {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'CALENDAR_UNAVAILABLE');
    assert.equal(response.json().complete, undefined);
  } finally { clearTimeout(alive); await app.close(); }
});
test('disconnecting a real calendar HTTP request aborts the school provider without starting another request', { timeout: 3000 }, async () => {
  let entered!: () => void, stopped!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), ended = new Promise<void>(resolve => { stopped = resolve; });
  const app = await buildApp(config, { getSession: async () => session } as unknown as Store, {
    ...unavailableSchoolProvider, calendar: async (_context, _query, options) => {
      entered(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { stopped(); reject(new AppError(503, 'CALENDAR_UNAVAILABLE', '합성')); }, { once: true }));
    },
  });
  const controller = new AbortController();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const pending = fetch(address + url, { headers, signal: controller.signal });
    await started; const rejected = assert.rejects(pending); controller.abort(); await Promise.all([rejected, ended]);
  } finally { controller.abort(); await app.close(); }
});
