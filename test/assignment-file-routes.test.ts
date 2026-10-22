import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const session = { user: { id: 'synthetic-owner' }, tokenHash: 'synthetic' }, headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr' };
const path = '/v1/courses/10/assignments/90/files/7';
test('authenticated assignment file route binds numeric IDs and serves PDF bytes with private headers and CORS', async () => {
  const calls: unknown[] = [];
  const app = await buildApp(config, { getSession: async () => session } as unknown as Store, { ...unavailableSchoolProvider,
    assignmentFile: async (context, courseId, assignmentId, fileId, options) => { calls.push({ context, courseId, assignmentId, fileId, refresh: options.refresh }); return { fileId, fileName: '답안.pdf', contentType: 'application/pdf', previewAvailable: true, bytes: Buffer.from('%PDF-abc') }; },
  });
  try {
    assert.equal((await app.inject(path)).statusCode, 401);
    for (const query of ['?url=https://private.test', '?download=0', '?refresh=0', '?userId=other', '?download=1&download=1'])
      assert.equal((await app.inject({ url: path + query, headers })).statusCode, 400);
    const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 200); assert.equal(response.body, '%PDF-abc');
    assert.equal(response.headers['cache-control'], 'private, no-store'); assert.match(response.headers['content-disposition'] as string, /^inline;/);
    assert.equal(response.headers['content-length'], '8'); assert.equal(response.headers['accept-ranges'], 'none'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], headers.origin); assert.match(String(response.headers['access-control-expose-headers']), /Content-Disposition/i);
    const download = await app.inject({ url: path + '?download=1&refresh=1', headers }); assert.match(download.headers['content-disposition'] as string, /^attachment;/);
    assert.deepEqual(calls.at(-1), { context: { userId: 'synthetic-owner' }, courseId: '10', assignmentId: '90', fileId: '7', refresh: true });
    assert.equal((await app.inject({ url: '/v1/courses/10/assignments/90/files/other', headers })).statusCode, 400);
  } finally { await app.close(); }
});
test('file route withholds a result after logout and rejects a provider mismatched file ID', async () => {
  for (const mode of ['logout', 'foreign', 'missing']) {
    let active = true;
    const app = await buildApp(config, { getSession: async () => active ? session : null } as unknown as Store, { ...unavailableSchoolProvider,
      ...(mode === 'missing' ? {} : { assignmentFile: async () => { if (mode === 'logout') active = false; return { fileId: mode === 'foreign' ? '8' : '7', fileName: '답안.pdf', contentType: 'application/pdf', previewAvailable: true, bytes: Buffer.from('%PDF-abc') }; } }),
    });
    try { const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, mode === 'logout' ? 401 : 503); assert.doesNotMatch(response.body, /%PDF-/); }
    finally { await app.close(); }
  }
});
test('Unicode boundary names remain downloadable through the authenticated HTTP route', async () => {
  for (const fileName of ['a'.repeat(239) + '😀.pdf', 'name-\ud800.pdf']) {
    const app = await buildApp(config, { getSession: async () => session } as unknown as Store, { ...unavailableSchoolProvider,
      assignmentFile: async () => ({ fileId: '7', fileName, contentType: 'application/pdf', previewAvailable: true, bytes: Buffer.from('%PDF-abc') }),
    });
    try {
      const response = await app.inject({ url: path + '?download=1', headers });
      assert.equal(response.statusCode, 200); assert.equal(response.body, '%PDF-abc');
      const disposition = String(response.headers['content-disposition']);
      assert.match(disposition, /^attachment;/);
      const decoded = decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!);
      assert.equal(decoded.isWellFormed(), true); assert.ok(decoded.length <= 240);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    } finally { await app.close(); }
  }
});
