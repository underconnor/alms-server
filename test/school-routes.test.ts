import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { createVideoStreamer } from '../src/video-stream.js';
import { Readable } from 'node:stream';
import { SchoolError } from '@alms/ssu-api';

test('attendance uses the authenticated owner and validated course filter', async () => {
  const calls: unknown[] = [];
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' } }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    attendance: async (context, courseId) => { calls.push({ context, courseId }); return { items: [] }; },
  });
  const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
  try {
    assert.equal((await app.inject('/v1/attendance?courseId=100')).statusCode, 401);
    assert.equal(calls.length, 0);
    assert.equal((await app.inject({ url: '/v1/attendance?courseId=100', headers })).statusCode, 200);
    assert.deepEqual(calls, [{ context: { userId: 'synthetic-owner' }, courseId: '100' }]);
    for (const query of ['courseId=100&userId=another-user', 'courseId=100&courseId=200', 'courseId=..%2F200']) {
      assert.equal((await app.inject({ url: '/v1/attendance?' + query, headers })).statusCode, 400);
    }
    assert.equal(calls.length, 1);
    assert.equal((await app.inject({ url: '/v1/attendance', headers })).statusCode, 200);
    assert.deepEqual(calls[1], { context: { userId: 'synthetic-owner' }, courseId: undefined });
  } finally { await app.close(); }
});

test('activity details require a session and bind only validated path IDs to its owner', async () => {
  const calls: unknown[] = [];
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' } }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    activity: async (context, courseId, moduleItemId) => { calls.push({ context, courseId, moduleItemId }); return { title: 'synthetic' }; },
  });
  const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
  try {
    assert.equal((await app.inject('/v1/courses/10/activities/30')).statusCode, 401);
    for (const url of ['/v1/courses/10/activities/30?userId=other', '/v1/courses/10/activities/..%2F20']) {
      assert.equal((await app.inject({url, headers})).statusCode, 400);
    }
    assert.equal(calls.length, 0);
    const response = await app.inject({url:'/v1/courses/10/activities/30', headers});
    assert.equal(response.statusCode, 200); assert.match(response.headers['cache-control']!, /no-store/);
    assert.deepEqual(calls, [{context:{userId:'synthetic-owner'},courseId:'10',moduleItemId:'30'}]);
  } finally { await app.close(); }
});

test('untracked manual videos require the exact understood representation without changing authorization', async () => {
  const activity = { type: 'video', manualVideoAvailable: true, manualVideoProgressMode: 'untracked' };
  let calls = 0;
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' } }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider, activity: async () => { calls++; return activity; },
  });
  const url = '/v1/courses/10/activities/30', cookie = '__Host-alms_session=' + 'a'.repeat(43);
  const supported = 'application/json; alms-manual-video=untracked';
  try {
    assert.equal((await app.inject({ url, headers: { accept: supported } })).statusCode, 401);
    assert.equal(calls, 0);
    for (const accept of [undefined, 'application/json', '*/*', 'application/json; alms-manual-video=tracked',
      'application/json; alms-manual-video=untracked, */*', 'application/json; alms-manual-video=untracked; extra=1']) {
      const response = await app.inject({ url, headers: { cookie, ...(accept ? { accept } : {}) } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().manualVideoAvailable, false);
      assert.equal(response.json().manualVideoProgressMode, 'untracked');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(activity.manualVideoAvailable, true);
    const response = await app.inject({ url, headers: { cookie, accept: supported } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().manualVideoAvailable, true);
    assert.equal(response.json().manualVideoProgressMode, 'untracked');
    assert.equal((await app.inject({ url: url + '?alms-manual-video=untracked', headers: { cookie, accept: supported } })).statusCode, 400);
  } finally { await app.close(); }
});

test('reference and unavailable video representations do not gain or lose capability from Accept negotiation', async () => {
  let activity: Record<string, unknown> = {};
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' } }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider, activity: async () => activity,
  });
  const url = '/v1/courses/10/activities/30', cookie = '__Host-alms_session=' + 'a'.repeat(43);
  try {
    for (const manualVideoAvailable of [false, true]) {
      for (const manualVideoProgressMode of ['not_applicable', null]) {
        activity = { manualVideoAvailable, manualVideoProgressMode };
        for (const accept of ['application/json', 'application/json; alms-manual-video=untracked']) {
          const response = await app.inject({ url, headers: { cookie, accept } });
          assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), activity);
        }
      }
    }
  } finally { await app.close(); }
});

test('PDF route only accepts owned path IDs and returns private non-cacheable inline bytes', async () => {
  const calls: unknown[] = [], bytes = Buffer.from('%PDF-1.7\nsynthetic');
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' } }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    material: async (context, courseId, moduleItemId, options) => { calls.push({ context, courseId, moduleItemId, ...(options ? { options } : {}) }); return { bytes }; },
  });
  const url = '/v1/courses/10/activities/30/material', headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr' };
  try {
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal((await app.inject({ url: url + '?url=https://foreign.test/file.pdf', headers })).statusCode, 400);
    for (const query of ['refresh=0', 'refresh=true', 'refresh=', 'refresh=1&refresh=1', 'refresh=1&unknown=x'])
      assert.equal((await app.inject({ url: url + '?' + query, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/v1/courses/10/activities/..%2F30/material', headers })).statusCode, 400);
    assert.equal(calls.length, 0);
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, bytes);
    assert.equal(response.headers['content-type'], 'application/pdf'); assert.equal(response.headers['content-length'], String(bytes.length));
    assert.equal(response.headers['cache-control'], 'private, no-store'); assert.equal(response.headers['accept-ranges'], 'none');
    assert.equal(response.headers['content-disposition'], 'inline; filename="material.pdf"');
    assert.match(response.headers['access-control-expose-headers']!, /Content-Encoding/i);
    assert.deepEqual(calls, [{ context: { userId: 'synthetic-owner' }, courseId: '10', moduleItemId: '30' }]);
    const retried = await app.inject({ url: url + '?refresh=1', headers });
    assert.equal(retried.statusCode, 200); assert.deepEqual(retried.rawPayload, bytes);
    assert.equal(retried.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls[1], { context: { userId: 'synthetic-owner' }, courseId: '10', moduleItemId: '30', options: { refresh: true } });
  } finally { await app.close(); }
});

test('PDF response is withheld when its ALMS session is logged out during the download', async () => {
  let active = true;
  const store = { getSession: async () => active ? { user: { id: 'synthetic-owner' }, tokenHash: 'synthetic-hash' } : null } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    material: async () => { active = false; return { bytes: Buffer.from('%PDF-1.7\nsynthetic') }; },
  });
  try {
    const response = await app.inject({ url: '/v1/courses/10/activities/30/material', headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43) } });
    assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'AUTH_REQUIRED');
    assert.doesNotMatch(response.body, /%PDF-/);
  } finally { await app.close(); }
});

test('material view is an explicit CSRF-protected POST without caller identity, completion or URL fields', async () => {
  const calls: unknown[] = [];
  const session = { user: { id: 'synthetic-owner' }, csrfToken: 'synthetic-csrf', tokenHash: 'synthetic-hash' };
  const store = { getSession: async () => session } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    recordMaterialView: async (context, courseId, moduleItemId, observation, validate) => {
      await validate(); calls.push({ context, courseId, moduleItemId, observation });
      return { report: 'recorded', activity: { completed: null } };
    },
  });
  const url = '/v1/courses/10/activities/30/view';
  const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr', 'x-csrf-token': 'synthetic-csrf' };
  try {
    assert.equal((await app.inject({ method: 'POST', url, payload: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie }, payload: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] } })).statusCode, 403);
    for (const changed of [{ origin: 'https://foreign.test' }, { 'x-csrf-token': 'incorrect' }])
      assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, ...changed }, payload: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] } })).statusCode, 403);
    for (const payload of [{ completed: true }, { userId: 'other' }, { url: 'https://foreign.test' }, { progress: 100 }, { event: 'opened', page: 3, totalPages: 2, viewedPages: [3] }, { event: 'opened', page: 1, totalPages: 2, viewedPages: [1, 1] }, { event: 'opened', page: 1, totalPages: 2, viewedPages: [2] }, { event: 'opened', page: 1, totalPages: 2, viewedPages: [1, 3] }])
      assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: url + '?completed=true', headers, payload: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 404);
    assert.equal(calls.length, 0);
    const response = await app.inject({ method: 'POST', url, headers, payload: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { report: 'recorded', activity: { completed: null } });
    assert.deepEqual(calls, [{ context: { userId: 'synthetic-owner' }, courseId: '10', moduleItemId: '30', observation: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] } }]);
    // The full allowed 10,000-page observation exceeds the app's default 32 KiB body limit.
    const maxPages = { event: 'page_changed', page: 10_000, totalPages: 10_000, viewedPages: Array.from({ length: 10_000 }, (_value, index) => index + 1) };
    assert.ok(Buffer.byteLength(JSON.stringify(maxPages)) > 32 * 1024);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: maxPages })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...maxPages, unexpected: 'x'.repeat(64 * 1024) } })).statusCode, 413);
  } finally { await app.close(); }
});

test('material view preparation rechecks logout before any school write and withholds revoked results', async () => {
  for (const phase of ['prepare', 'after-write']) {
    let active = true, writes = 0;
    const store = { getSession: async () => active ? { user: { id: 'synthetic-owner' }, csrfToken: 'synthetic-csrf', tokenHash: 'synthetic-hash' } : null } as unknown as Store;
    const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
      ...unavailableSchoolProvider,
      recordMaterialView: async (_context, _courseId, _moduleItemId, _observation, validate) => {
        if (phase === 'prepare') active = false;
        await validate(); writes++;
        if (phase === 'after-write') active = false;
        return { report: 'recorded', privateValue: 'do-not-publish' };
      },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/courses/10/activities/30/view', payload: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] },
        headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr', 'x-csrf-token': 'synthetic-csrf' } });
      assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'AUTH_REQUIRED');
      assert.doesNotMatch(response.body, /do-not-publish/); assert.equal(writes, phase === 'prepare' ? 0 : 1);
    } finally { await app.close(); }
  }
});

test('material view remains unavailable without a verified reporting provider', async () => {
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' }, csrfToken: 'synthetic-csrf', tokenHash: 'synthetic-hash' }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/courses/10/activities/30/view', payload: { event: 'opened', page: 1, totalPages: 2, viewedPages: [1] },
      headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr', 'x-csrf-token': 'synthetic-csrf' } });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'MATERIAL_VIEW_UNAVAILABLE');
  } finally { await app.close(); }
});

test('unsupported media preparation returns a JSON 502 with allowed-origin CORS before streaming', async () => {
  let mediaFetches = 0;
  const stream = createVideoStreamer(async () => { mediaFetches++; throw new Error('must not fetch media'); });
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' } }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    video: (context, _course, _activity, request) => stream(context.userId, async () => { throw new SchoolError('unsupported'); }, request),
  });
  try {
    const response = await app.inject({ url: '/v1/courses/10/activities/20/media', headers: {
      cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr', range: 'bytes=0-',
    } });
    assert.equal(response.statusCode, 502); assert.match(response.headers['content-type']!, /^application\/json/);
    assert.equal(response.headers['access-control-allow-origin'], 'https://lms.flyjung.kr');
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.equal(response.json().error.code, 'VIDEO_UNAVAILABLE'); assert.equal(mediaFetches, 0);
  } finally { await app.close(); }
});

test('manual media GET and HEAD require the same owner and preserve validated Range headers', async () => {
  const calls: unknown[] = [];
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' }, tokenHash: 'synthetic-hash' }) } as unknown as Store;
  const stream = createVideoStreamer(async (_url, init) => new Response(init?.method === 'HEAD' ? null : '23', {
    status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '2', 'Content-Range': 'bytes 1-2/4' },
  }));
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    video: async (context, courseId, moduleItemId, request) => {
      calls.push({ context, courseId, moduleItemId, method: request.method });
      return stream(context.userId, async () => ({ contentId: 'synthetic',
        mediaUrl: 'https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/mobile/video.mp4',
        validate: async () => {},
      }), request);
    },
  });
  const url = '/v1/courses/10/activities/20/media', headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), range: 'bytes=1-2' };
  try {
    for (const method of ['GET','HEAD'] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
      assert.equal((await app.inject({ method, url: url + '?url=https://foreign.test/video', headers })).statusCode, 400);
      const result = await app.inject({ method, url, headers });
      assert.equal(result.statusCode, 206); assert.equal(result.body, method === 'HEAD' ? '' : '23');
      assert.equal(result.headers['content-type'], 'video/mp4'); assert.equal(result.headers['content-length'], '2');
      assert.equal(result.headers['content-range'], 'bytes 1-2/4'); assert.equal(result.headers['accept-ranges'], 'bytes');
      assert.equal(result.headers['cache-control'], 'private, no-store');
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { context: { userId: 'synthetic-owner' }, courseId: '10', moduleItemId: '20', method: 'GET' });
  } finally { await app.close(); }
});

test('logout before media response headers withholds the stream and aborts its upstream request', async () => {
  let active = true, cancelled = false;
  const store = { getSession: async () => active ? { user: { id: 'synthetic-owner' }, tokenHash: 'synthetic-hash' } : null } as unknown as Store;
  const stream = createVideoStreamer(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } }));
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    video: async (context, _courseId, _moduleItemId, request) => {
      const result = await stream(context.userId, async () => ({ contentId: 'synthetic',
        mediaUrl: 'https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/mobile/video.mp4',
        validate: async () => {},
      }), request);
      active = false; return result;
    },
  });
  try {
    const result = await app.inject({ url: '/v1/courses/10/activities/20/media', headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43) } });
    assert.equal(result.statusCode, 401); assert.equal(result.json().error.code, 'AUTH_REQUIRED');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
  } finally { await app.close(); }
});

test('a hanging final session lookup times out before committing media headers', { timeout: 8000 }, async () => {
  let checks = 0, aborted = false;
  const store = { getSession: async () => {
    if (++checks > 1) return new Promise(() => {});
    return { user: { id: 'synthetic-owner' }, tokenHash: 'synthetic-hash' };
  } } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    video: async (_context, _course, _module, request) => {
      request.signal.addEventListener('abort', () => { aborted = true; });
      return { status: 200, contentLength: 4, body: Readable.from([Buffer.from('1234')]) };
    },
  });
  try {
    const result = await app.inject({ url: '/v1/courses/10/activities/20/media', headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43) } });
    assert.equal(result.statusCode, 502); assert.equal(result.json().error.code, 'VIDEO_UNAVAILABLE');
    assert.equal(aborted, true); assert.notEqual(result.headers['content-type'], 'video/mp4');
  } finally { await app.close(); }
});

test('a real HTTP client disconnect cancels its upstream media read', { timeout: 3000 }, async () => {
  let cancelled!: () => void;
  const stopped = new Promise<void>(resolve => { cancelled = resolve; });
  const store = { getSession: async () => ({ user: { id: 'synthetic-owner' }, tokenHash: 'synthetic-hash' }) } as unknown as Store;
  const stream = createVideoStreamer(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled(); },
  }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } }));
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    video: async (context, _course, _module, request) => stream(context.userId, async () => ({ contentId: 'synthetic',
      mediaUrl: 'https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/mobile/video.mp4',
      validate: async () => {},
    }), request),
  });
  const controller = new AbortController();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(address + '/v1/courses/10/activities/20/media', {
      headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43) }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.body!.getReader().read()).value?.byteLength, 1);
    controller.abort(); await stopped;
  } finally { controller.abort(); await app.close(); }
});
