import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseSchoolVideoLaunch, inspectSchoolVideoLaunch, type LearningxClient, type SchoolVideoLaunch, type SchoolVideoMedia, SchoolError } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { createVideoStreamer, type VideoRequest } from '../src/video-stream.js';
import { AppError } from '../src/errors.js';
import type { SchoolReadCache } from '../src/school-read-cache.js';

const contentId = 'synthetic-video';
const reference = { courseId: '10', moduleItemId: '20', itemId: '30' };
const row = (overrides: Record<string, unknown> = {}) => ({
  course_id: 10, item_id: 30, title: '합성 참고 영상', item_content_type: 'commons', published: true, opened: true, use_attendance: false,
  viewer_url: `https://commons.ssu.ac.kr/em/${contentId}?TargetUrl=synthetic-secret`,
  item_content_data: { content_type: 'movie', content_id: contentId, duration: 600 }, attendance_data: {}, ...overrides,
});
const matches = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const request = (): VideoRequest => ({ method: 'HEAD', signal: new AbortController().signal, validate: async () => {} });
function fixture() {
  const key = randomBytes(32); let stored = '';
  const reset = () => { stored = encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: { cookies: [] } }, key, 'owner', 'ssu'); };
  reset();
  const store = {
    getEncryptedSchoolSession: async () => stored,
    replaceEncryptedSchoolSession: async (_owner: string, _provider: string, before: string, after: string) => {
      if (before !== stored) return false; stored = after; return true;
    },
  };
  let details: Record<string, unknown> = {}, launches = 0, resolutions = 0, fetches = 0;
  let beforeResolve = async () => {}, resolvedAttendance: boolean | undefined, identities = 0, identityValid = true, enrolled = true, pureCanvas: boolean | null = true;
  const client = {
    terms: async () => [{ id: '1', name: '합성 학기', default: true }],
    courses: async () => enrolled ? [{ id: '10', name: '합성 강좌', termId: '1', professors: null, usePureCanvas: pureCanvas }] : [],
    todos: async () => [],
    moduleActivityDetail: async () => inspectSchoolVideoLaunch(parseSchoolVideoLaunch(row(details), reference)).detail,
    moduleActivityVideoLaunch: async () => { launches++; return parseSchoolVideoLaunch(row(details), reference); },
  } as unknown as LearningxClient;
  let launch: SchoolVideoLaunch;
  const operations = {
    resolve: async (source: SchoolVideoLaunch) => { resolutions++; launch = source; await beforeResolve(); return {} as SchoolVideoMedia; },
    inspect: () => ({ ...inspectSchoolVideoLaunch(launch),
      mediaUrl: inspectSchoolVideoLaunch(launch).contentType === 'readystream'
        ? `https://ssu-toast.commonscdn.com/contents31/ssu1000001/${contentId}/contents/media_files/video(01).mp4`
        : `https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/${contentId}/contents/media_files/mobile/video.mp4`,
      mimeType: 'video/mp4' as const, delivery: 'progressive' as const,
      useAttendance: resolvedAttendance ?? inspectSchoolVideoLaunch(launch).detail.useAttendance as boolean,
    }),
    stream: createVideoStreamer(async () => { fetches++; return new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '619492057' } }); }),
  };
  const writes: string[] = [], reads: string[] = [];
  const durable: SchoolReadCache = { get: async scope => { reads.push(scope.resource); return null; },
    put: async (scope, value) => { assert.doesNotMatch(JSON.stringify(value), /private-school-video|synthetic-secret|mediaUrl/); writes.push(scope.resource); return true; }, delete: async () => {} };
  const reader = createLearningxReader(store, key, async () => ({ client, verifyVideoIdentity: async () => { identities++; if (!identityValid) throw new SchoolError('identity_mismatch'); }, serialize: async () => ({ cookies: [] }) }), undefined, durable, operations);
  return { reader, reset, identityCount: () => identities, setIdentity: (value: boolean) => { identityValid = value; },
    setEnrolled: (value: boolean) => { enrolled = value; }, setPureCanvas: (value: boolean | null) => { pureCanvas = value; }, setDetails: (value: Record<string, unknown>) => { details = value; },
    setResolvedAttendance: (value: boolean) => { resolvedAttendance = value; },
    onResolve: (fn: () => Promise<void>) => { beforeResolve = fn; }, counts: () => ({ launches, resolutions, fetches }), reads, writes };
}

test('owned reference sources are read afresh and their opaque handles never enter durable caches', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await f.reader.readVideo!('owner', '10', '20', request());
    assert.equal(result.contentLength, 619492057); assert.equal(result.body, null);
  }
  assert.deepEqual(f.counts(), { launches: 2, resolutions: 2, fetches: 2 });
  assert.deepEqual(f.writes, ['catalog:all']);
  assert.equal(f.reads.some(name => name.startsWith('video:')), false);
});
test('unowned courses fail before launch; unknown attendance flags fail before anonymous metadata', async () => {
  const f = fixture();
  await assert.rejects(f.reader.readVideo!('owner', '99', '20', request()), matches('NOT_FOUND'));
  assert.deepEqual(f.counts(), { launches: 0, resolutions: 0, fetches: 0 });
  for (const use_attendance of [null, undefined]) {
    f.setDetails({ use_attendance });
    await assert.rejects(f.reader.readVideo!('owner', '10', '20', request()), matches('VIDEO_UNAVAILABLE'));
  }
  assert.deepEqual(f.counts(), { launches: 2, resolutions: 0, fetches: 0 });
});
test('explicit attendance-bearing videos allow manual bytes without claiming a progress report', async () => {
  const f = fixture(); f.setDetails({ use_attendance: true });
  const result = await f.reader.readVideo!('owner', '10', '20', request());
  assert.equal(result.status, 200); assert.equal(result.body, null);
  assert.deepEqual(f.counts(), { launches: 1, resolutions: 1, fetches: 1 });
  assert.deepEqual(f.writes, ['catalog:all']);
});
test('resolved attendance mode must match the fresh owned activity before media bytes', async () => {
  for (const useAttendance of [true, false]) {
    const f = fixture(); f.setDetails({ use_attendance: useAttendance }); f.setResolvedAttendance(!useAttendance);
    await assert.rejects(f.reader.readVideo!('owner', '10', '20', request()), matches('VIDEO_UNAVAILABLE'));
    assert.deepEqual(f.counts(), { launches: 1, resolutions: 1, fetches: 0 });
  }
});
test('wrong module, closed or unpublished activities cannot reach anonymous metadata or media', async () => {
  const f = fixture();
  await assert.rejects(f.reader.readVideo!('owner', '10', '21', request()));
  for (const detail of [{ opened: false }, { published: false }]) {
    f.setDetails(detail); await assert.rejects(f.reader.readVideo!('owner', '10', '20', request()));
  }
  assert.equal(f.counts().resolutions, 0); assert.equal(f.counts().fetches, 0);
});
test('login generation replacement during anonymous resolution rejects before fetching media', async () => {
  const f = fixture(); f.onResolve(async () => f.reset());
  await assert.rejects(f.reader.readVideo!('owner', '10', '20', request()), matches('SCHOOL_SESSION_CHANGED'));
  assert.equal(f.counts().fetches, 0);
});
test('the owner lock is released before anonymous resolution, allowing independent school reads', { timeout: 2000 }, async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.onResolve(async () => { started(); await gate; });
  const pending = f.reader.readVideo!('owner', '10', '20', request()); await ready;
  assert.deepEqual((await f.reader.readTasks('owner')).groups, []);
  release(); assert.equal((await pending).status, 200);
});
test('public detail distinguishes untracked attendance videos, reference videos and unknown support without source URLs', async () => {
  const f = fixture();
  for (const useAttendance of [false, true, null]) {
    f.reader.readActivity = async () => ({ course: { id: '10', title: '합성', professor: null, term: null, sourceUrl: null },
      detail: inspectSchoolVideoLaunch(parseSchoolVideoLaunch(row({ use_attendance: useAttendance }), reference)).detail,
      observedAt: new Date().toISOString() });
    const result = await createLearningxReads(f.reader).activity!({ userId: 'owner' }, '10', '20') as Record<string, unknown>;
    assert.equal(result.manualVideoAvailable, useAttendance !== null);
    assert.equal(result.manualVideoProgressMode, useAttendance === true ? 'untracked' : useAttendance === false ? 'not_applicable' : null);
    assert.doesNotMatch(JSON.stringify(result), /viewer_url|viewerUrl|mediaUrl|synthetic-secret|commonscdn/);
  }
});
test('closed, unpublished or absent manual provider details never advertise a manual progress mode', async () => {
  for (const overrides of [{ opened: false }, { published: false }, {}]) {
    const f = fixture();
    if (!Object.keys(overrides).length) f.reader.readVideo = undefined;
    f.reader.readActivity = async () => ({ course: { id: '10', title: '합성', professor: null, term: null, sourceUrl: null },
      detail: { ...inspectSchoolVideoLaunch(parseSchoolVideoLaunch(row({ use_attendance: true }), reference)).detail, ...overrides },
      observedAt: new Date().toISOString() });
    const result = await createLearningxReads(f.reader).activity!({ userId: 'owner' }, '10', '20') as Record<string, unknown>;
    assert.equal(result.manualVideoAvailable, false); assert.equal(result.manualVideoProgressMode, null);
  }
});

const readyDetails = { use_attendance: true, omit_progress: false,
  item_content_data: { content_type: 'readystream', content_id: contentId, duration: 600 } };
test('selected readystream detail verifies media privately and following byte requests reuse it after fresh authority reads', async () => {
  const f = fixture(); f.setDetails(readyDetails);
  const reads = createLearningxReads(f.reader);
  for (let i = 0; i < 2; i++) {
    const value = await reads.activity!({ userId: 'owner' }, '10', '20') as Record<string, unknown>;
    assert.equal(value.resourceType, 'readystream'); assert.equal(value.type, 'video');
    assert.equal(value.manualVideoAvailable, true); assert.equal(value.manualVideoReportAvailable, true);
    assert.equal(value.manualVideoProgressMode, 'untracked');
    assert.doesNotMatch(JSON.stringify(value), /readystreamMediaVerified|viewerUrl|mediaUrl|synthetic-secret|commonscdn/);
  }
  await f.reader.readVideo!('owner', '10', '20', request());
  assert.equal(f.identityCount(), 3); assert.deepEqual(f.counts(), { launches: 3, resolutions: 1, fetches: 1 });
  assert.deepEqual(f.writes, ['catalog:all', 'activity:10:20']);
});
test('unsupported readystream manifests keep readable body metadata and close manual capabilities', async () => {
  const f = fixture(); f.setDetails(readyDetails); f.onResolve(async () => { throw new SchoolError('unsupported'); });
  const value = await createLearningxReads(f.reader).activity!({ userId: 'owner' }, '10', '20') as Record<string, unknown>;
  assert.equal(value.title, '합성 참고 영상'); assert.equal(value.resourceType, 'readystream');
  assert.equal(value.manualVideoAvailable, false); assert.equal(value.manualVideoReportAvailable, false); assert.equal(value.manualVideoProgressMode, null);
  f.onResolve(async () => {});
  assert.equal((await createLearningxReads(f.reader).activity!({ userId: 'owner' }, '10', '20') as Record<string, unknown>).manualVideoAvailable, true);
  assert.equal(f.counts().resolutions, 2);
});
test('readystream cache hits cannot bypass fresh native identity, pureCanvas mode, enrollment or generation', async () => {
  for (const mode of ['identity', 'enrollment', 'legacy', 'unknown', 'generation']) {
    const f = fixture(); f.setDetails(readyDetails); await f.reader.readVideo!('owner', '10', '20', request());
    if (mode === 'identity') f.setIdentity(false); if (mode === 'enrollment') f.setEnrolled(false);
    if (mode === 'legacy') f.setPureCanvas(false); if (mode === 'unknown') f.setPureCanvas(null);
    if (mode === 'generation') { f.reset(); await f.reader.readVideo!('owner', '10', '20', request()); assert.equal(f.counts().resolutions, 2); }
    else { await assert.rejects(f.reader.readVideo!('owner', '10', '20', request())); assert.equal(f.counts().resolutions, 1); }
  }
});
