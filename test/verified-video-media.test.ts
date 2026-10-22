import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchoolVideoLaunch, prepareSchoolVideoCallbackBinding } from '@alms/ssu-api';
import { createVerifiedVideoMediaCache } from '../src/verified-video-media.js';
import { readystreamXml } from './helpers/readystream-fixture.js';

const row = (patch: Record<string, unknown> = {}, content = 'synthetic-video') => ({ course_id: 10, item_id: 30, title: '합성 영상', item_content_type: 'commons',
  published: true, opened: true, use_attendance: true, omit_progress: false,
  item_content_data: { content_type: 'readystream', content_id: content, duration: 600 },
  attendance_data: { progress: 0, last_at: 0, completed: false, attendance_status: 'none' },
  viewer_url: `https://commons.ssu.ac.kr/em/${content}?endat=0&TargetUrl=` + encodeURIComponent(`https://canvas.ssu.ac.kr/learningx/api/v1/courses/10/sections/17/components/30/progress?user_id=90000001&content_id=${content}&content_type=readystream`), ...patch });
const launch = (patch: Record<string, unknown> = {}, content?: string) => parseSchoolVideoLaunch(row(patch, content), { courseId: '10', moduleItemId: '20', itemId: '30' });
const noop = async () => {}, signal = () => AbortSignal.timeout(5000);
function transport() {
  let requests = 0, duration = 600, fail = false;
  const fetcher: typeof fetch = async (input, init) => {
    requests++; assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('cookie'), null); assert.equal(new Headers(init?.headers).get('authorization'), null);
    if (fail) throw new Error('synthetic failed request');
    const url = new URL(String(input));
    const content = url.pathname.startsWith('/em/') ? url.pathname.slice(4) : url.searchParams.get('content_id')!;
    return new Response(url.pathname.startsWith('/em/')
      ? `<script>var contentUri='https://commons.ssu.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=${content}';</script>`
      : readystreamXml(content, duration), { headers: { 'Content-Type': url.pathname.startsWith('/em/') ? 'text/html' : 'text/xml' } });
  };
  return { fetcher, requests: () => requests, setDuration: (value: number) => { duration = value; }, setFailure: (value: boolean) => { fail = value; } };
}
test('only the original proven opaque launch is reused; proof never transfers to a fresh object', async () => {
  const f = transport(), cache = createVerifiedVideoMediaCache(), first = launch(), fresh = launch();
  const a = await cache('owner', 'generation', first, noop, signal(), f.fetcher);
  const b = await cache('owner', 'generation', fresh, noop, signal(), f.fetcher);
  assert.equal(a, b); assert.equal(b.launch, first); assert.notEqual(b.launch, fresh); assert.equal(f.requests(), 2);
  assert.throws(() => prepareSchoolVideoCallbackBinding(fresh, '90000001'), { code: 'unsupported' });
  assert.doesNotThrow(() => prepareSchoolVideoCallbackBinding(b.launch, '90000001'));
});
test('owner, generation, complete viewer, native flags, duration and attendance baseline change the cache key', async () => {
  const f = transport(), cache = createVerifiedVideoMediaCache();
  await cache('owner', 'generation', launch(), noop, signal(), f.fetcher);
  await cache('other', 'generation', launch(), noop, signal(), f.fetcher);
  await cache('owner', 'new-generation', launch(), noop, signal(), f.fetcher);
  const variants = [{ viewer_url: row().viewer_url.replace('endat=0', 'endat=1') },
    { title: '새 학교 본문' }, { description: '학교 메타 변경' }, { use_attendance: false },
    { attendance_data: { progress: 1, last_at: 2, completed: false, attendance_status: 'none' } },
    { attendance_data: { progress: 0, last_at: 0, completed: true, attendance_status: 'attendance' } }];
  let resolved = 3;
  for (const patch of variants) {
    await cache('owner', 'generation', launch(patch), noop, signal(), f.fetcher); resolved++;
    assert.equal(f.requests(), resolved * 2, JSON.stringify(patch));
  }
  f.setDuration(601);
  await cache('owner', 'generation', launch({ item_content_data: { content_type: 'readystream', content_id: 'synthetic-video', duration: 601 } }), noop, signal(), f.fetcher);
  assert.equal(f.requests(), (resolved + 1) * 2);
});
test('TTL expires without sliding hits, and bounded eviction releases only oldest private cache entries', async () => {
  const f = transport(); let now = 0;
  const cache = createVerifiedVideoMediaCache(undefined, { now: () => now, ttlMs: 30, entries: 2 });
  const get = (content: string) => cache('owner', 'gen', launch({}, content), noop, signal(), f.fetcher);
  await get('first'); now = 29; await get('first'); assert.equal(f.requests(), 2);
  now = 30; await get('first'); assert.equal(f.requests(), 4);
  await get('second'); await get('third'); assert.equal(f.requests(), 8);
  await get('second'); assert.equal(f.requests(), 8); await get('first'); assert.equal(f.requests(), 10);
});
test('revoked authority and aborted callers reject hits without sharing signal or validation lifetime', async () => {
  const f = transport(), cache = createVerifiedVideoMediaCache();
  await cache('owner', 'generation', launch(), noop, signal(), f.fetcher);
  await assert.rejects(cache('owner', 'generation', launch(), async () => { throw new Error('revoked'); }, signal(), f.fetcher), /revoked/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(cache('owner', 'generation', launch(), noop, aborted.signal, f.fetcher));
  const valid = await cache('owner', 'generation', launch(), noop, signal(), f.fetcher);
  assert.ok(valid.launch); assert.equal(f.requests(), 2);
});
test('failed or canceled pending resolutions cannot populate a success entry for a later request', async () => {
  const f = transport(), cache = createVerifiedVideoMediaCache(); f.setFailure(true);
  await assert.rejects(cache('owner', 'gen', launch(), noop, signal(), f.fetcher)); f.setFailure(false);
  const controller = new AbortController(); let validations = 0;
  await assert.rejects(cache('owner', 'gen', launch(), async () => { if (++validations === 3) controller.abort(); }, controller.signal, f.fetcher));
  const before = f.requests(); await cache('owner', 'gen', launch(), noop, signal(), f.fetcher);
  assert.equal(f.requests(), before + 2);
});
