import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { AppError } from '../src/errors.js';
import { historyFixture } from './helpers/assignment-history-fixture.js';
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const session = { user: { id: 'synthetic-owner' }, tokenHash: 'synthetic' }, headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr' };
const path = '/v1/courses/10/assignments/90/submission-history', filePath = path + '/' + 'a'.repeat(64) + '/files/7';
const file = (fileId = '7') => ({ fileId, fileName: '합성 이전 답안.pdf', contentType: 'application/pdf', previewAvailable: true, bytes: Buffer.from('%PDF-one') });
test('history and selected files are authenticated GET-only routes with exact target/query validation', async () => {
  const calls: unknown[] = [];
  const app = await buildApp(config, { getSession: async () => session } as unknown as Store, { ...unavailableSchoolProvider,
    assignmentHistory: async (context, courseId, assignmentId, options) => { calls.push({ context, courseId, assignmentId, refresh: options.refresh }); return historyFixture(); },
    assignmentHistoryFile: async (context, courseId, assignmentId, attemptKey, fileId, options) => { calls.push({ context, courseId, assignmentId, attemptKey, fileId, refresh: options.refresh }); return file(); },
  });
  try {
    for (const target of [path, filePath]) {
      assert.equal((await app.inject(target)).statusCode, 401);
      for (const query of ['?userId=other', '?url=https://private.invalid', '?attempt=1', '?refresh=0', '?refresh=1&refresh=1'])
        assert.equal((await app.inject({ url: target + query, headers })).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url: target, headers })).statusCode, 404);
    }
    const history = await app.inject({ url: path + '?refresh=1', headers }); assert.equal(history.statusCode, 200);
    assert.equal(history.json().items.length, 2); assert.equal(history.headers['cache-control'], 'no-store');
    assert.equal(history.headers['access-control-allow-origin'], headers.origin);
    const bytes = await app.inject({ url: filePath, headers }); assert.equal(bytes.statusCode, 200); assert.equal(bytes.body, '%PDF-one');
    assert.equal(bytes.headers['cache-control'], 'private, no-store'); assert.match(String(bytes.headers['content-disposition']), /^inline;/);
    assert.equal(bytes.headers['content-length'], '8'); assert.equal(bytes.headers['x-content-type-options'], 'nosniff');
    assert.equal(bytes.headers['accept-ranges'], 'none'); assert.equal(bytes.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(bytes.headers['access-control-allow-origin'], headers.origin); assert.match(String(bytes.headers['access-control-expose-headers']), /Content-Disposition/i);
    const saved = await app.inject({ url: filePath + '?download=1&refresh=1', headers }); assert.match(String(saved.headers['content-disposition']), /^attachment;/);
    assert.deepEqual(calls[0], { context: { userId: 'synthetic-owner' }, courseId: '10', assignmentId: '90', refresh: true });
    assert.deepEqual(calls.at(-1), { context: { userId: 'synthetic-owner' }, courseId: '10', assignmentId: '90', attemptKey: 'a'.repeat(64), fileId: '7', refresh: true });
    for (const key of ['a_' + 'a'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), '1'])
      assert.equal((await app.inject({ url: path + '/' + key + '/files/7', headers })).statusCode, 400);
    assert.equal((await app.inject({ url: path.replace('/10/', '/other/'), headers })).statusCode, 400);
  } finally { await app.close(); }
});
test('history missing/null remain explicit and malformed/cross-target/provider failure cannot fabricate success', async () => {
  for (const mode of ['missing', 'null', 'foreign', 'malformed', 'unavailable', 'school']) {
    const app = await buildApp(config, { getSession: async () => session } as unknown as Store, { ...unavailableSchoolProvider,
      ...(mode === 'unavailable' ? {} : { assignmentHistory: async () => {
        if (mode === 'school') throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '합성');
        const value = historyFixture(); if (mode === 'missing' || mode === 'null') { value.state = mode; value.items = null; }
        if (mode === 'foreign') value.assignmentId = '91'; if (mode === 'malformed') value.items![0]!.key = 'raw-key'; return value;
      } }),
    });
    try {
      const response = await app.inject({ url: path, headers });
      if (mode === 'missing' || mode === 'null') { assert.equal(response.statusCode, 200); assert.equal(response.json().state, mode); assert.equal(response.json().items, null); }
      else { assert.equal(response.statusCode, mode === 'unavailable' ? 503 : mode === 'school' ? 401 : 502); assert.equal(response.json().items, undefined); }
    } finally { await app.close(); }
  }
});
test('revocation after history/file reads withholds the payload, and mismatched files cannot leave the route', async () => {
  for (const mode of ['history', 'file', 'foreign-file']) {
    let active = true;
    const app = await buildApp(config, { getSession: async () => active ? session : null } as unknown as Store, { ...unavailableSchoolProvider,
      assignmentHistory: async () => { active = false; return historyFixture(); },
      assignmentHistoryFile: async () => { if (mode === 'file') active = false; return file(mode === 'foreign-file' ? '8' : '7'); },
    });
    try { const response = await app.inject({ url: mode === 'history' ? path : filePath, headers });
      assert.equal(response.statusCode, mode === 'foreign-file' ? 503 : 401); assert.equal(response.json().items, undefined); assert.doesNotMatch(response.body, /%PDF-/);
    } finally { await app.close(); }
  }
});
test('history deadline bounds a stalled final ALMS authorization check', async t => {
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  let calls = 0;
  const app = await buildApp(config, { getSession: async () => ++calls === 3 ? new Promise(() => {}) : session } as unknown as Store,
    { ...unavailableSchoolProvider, assignmentHistory: async () => historyFixture() });
  const alive = setTimeout(() => {}, 100);
  try { const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'ASSIGNMENTS_UNAVAILABLE'); }
  finally { clearTimeout(alive); await app.close(); }
});
