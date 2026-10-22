import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolError, SchoolMaterialViewError, type LearningxClient, type SchoolActivityDetail } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import type { MaterialViewObservation } from '../src/provider.js';
import type { SchoolReadCache } from '../src/school-read-cache.js';
import { materialViewFailureDiagnostic } from '../src/material-view-diagnostics.js';

type Reporter = NonNullable<Parameters<typeof createLearningxReader>[6]>;
const observation: MaterialViewObservation = { event: 'opened', page: 1, totalPages: 3, viewedPages: [1] };
const validate = async () => {};
const detail = (completed: boolean | null = false): SchoolActivityDetail => ({ courseId: '10', moduleItemId: '30', itemId: '40',
  title: 'Synthetic PDF', descriptionText: '', itemContentType: 'commons', resourceType: 'pdf', published: true,
  opened: true, useAttendance: false, omitProgress: false, unlockAt: null, dueAt: null, lateAt: null, lockAt: null,
  materialViewerUrl: 'https://commons.ssu.ac.kr/em/synthetic', fileName: 'synthetic.pdf', reportedSizeBytes: 1234,
  durationValue: null, durationSeconds: null, attendance: { completed, status: 'none', progressValue: null,
    lastPositionValue: null, progressSeconds: null, lastPositionSeconds: null, progressPercent: null } });
function fixture(reporter?: Reporter, durable?: SchoolReadCache) {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(),
    identity: { studentId: '90000001' }, jar: { cookies: [] } }, key, owner, 'ssu'));
  replace('owner-a'); replace('owner-b');
  let owned = true, completed: boolean | null = false, catalogReads = 0, activityReads = 0, courseReads = 0;
  let moduleCompleted: boolean | null = false, moduleId = '30';
  const client = { terms: async () => [{ id: '1', name: 'Synthetic term', default: true }],
    courses: async () => { catalogReads++; return owned ? [{ id: '10', name: 'Synthetic course', termId: '1', professors: null }] : []; },
    modules: async () => { courseReads++; return [{id:'20',title:'Synthetic week',week:1,items:[{id:moduleId,title:'Synthetic PDF',contentType:'attendance_item',itemContentType:'commons',resourceType:'pdf',completed:moduleCompleted,published:true,sourceUrl:''}]}]; },
    moduleActivityDetail: async () => { activityReads++; return detail(completed); },
  } as unknown as LearningxClient;
  const store = { getEncryptedSchoolSession: async (owner: string) => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, previous: string, next: string) => {
      if (states.get(owner) !== previous) return false;
      states.set(owner, next); return true;
    } };
  const reader = createLearningxReader(store, key, async () => ({ client, serialize: async () => ({ cookies: [] }) }),
    async () => Buffer.from('%PDF-1.7\nsynthetic'), durable, undefined, reporter ?? null);
  return { reader, states, replace, setOwned: (value: boolean) => { owned = value; },
    setCompleted: (value: boolean | null) => { completed = value; },
    setModuleCompleted: (value: boolean | null) => { moduleCompleted = value; }, setModuleId: (value: string) => { moduleId = value; },
    counts: () => ({ catalogReads, activityReads, courseReads }) };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('reads and speculative PDF warmup do not report views; unsupported reporter exposes no capability', async () => {
  const f = fixture();
  assert.equal(f.reader.recordMaterialView, undefined);
  const provider = createLearningxReads(f.reader);
  assert.equal(provider.recordMaterialView, undefined);
  const value = await provider.activity!({ userId: 'owner-a' }, '10', '30') as any;
  assert.equal(value.materialViewAvailable, false);
  await f.reader.readCourse('owner-a', '10'); await f.reader.readMaterial!('owner-a', '10', '30'); await flush();
});

test('material reporting availability requires an explicit school progress-enabled PDF', async () => {
  for (const omitProgress of [true, null, undefined, false]) {
    const reader = { readActivity: async () => ({ course: { id: '10', title: 'Synthetic', professor: null, term: null, sourceUrl: null },
      detail: { ...detail(), omitProgress }, observedAt: '2026-10-02T00:00:00Z' }),
      recordMaterialView: async () => { assert.fail('capability reads must never report a view'); } } as any;
    const value = await createLearningxReads(reader).activity!({ userId: 'owner-a' }, '10', '30') as any;
    assert.equal(value.materialViewAvailable, omitProgress === false);
  }
});

test('view records use fresh owned school data, return school completion unchanged, and invalidate dependent caches', async () => {
  let writes = 0; const invalidated: string[] = [];
  const durable = { get: async () => null, put: async () => true,
    delete: async (_owner: string, _provider: string, resource?: string) => { invalidated.push(resource ?? '*'); } } as SchoolReadCache;
  const f = fixture(async (client, courseId, moduleItemId, seen, beforeWrite) => {
    assert.deepEqual(seen, observation); assert.equal(courseId, '10'); assert.equal(moduleItemId, '30');
    await beforeWrite(); writes++;
    f.setCompleted(null);
    return { detail: await client.moduleActivityDetail(courseId, moduleItemId), report: 'recorded' };
  }, durable);
  await f.reader.catalog('owner-a'); await f.reader.readCourse('owner-a', '10'); await f.reader.readActivity!('owner-a', '10', '30'); await flush();
  const before = f.counts();
  const value = await createLearningxReads(f.reader).recordMaterialView!({ userId: 'owner-a' }, '10', '30', observation, validate) as any;
  assert.equal(writes, 1); assert.equal(value.report, 'recorded'); assert.equal(value.activity.completed, null);
  assert.equal(value.activity.materialViewAvailable, true); assert.equal(value.activity.attendanceStatus, 'none');
  assert.equal(f.counts().catalogReads, before.catalogReads + 1);
  await f.reader.readCourse('owner-a', '10'); await f.reader.readActivity!('owner-a', '10', '30'); await flush();
  assert.equal(f.counts().courseReads, before.courseReads + 2);
  assert.equal(f.counts().activityReads, before.activityReads + 2);
  for (const resource of ['course:10', 'activity:10:30', 'tasks', 'attendance', 'attendance:10']) assert.ok(invalidated.includes(resource));
  assert.doesNotMatch(JSON.stringify(value), /viewerUrl|itemId|studentId|cookies/);
});

test('already-completed PDF returns fresh school completion without a write gate and clears stale dependent caches', async () => {
  const invalidated: string[] = [];
  const durable = { get: async () => null, put: async () => true,
    delete: async (owner: string, _provider: string, resource?: string) => { assert.equal(owner, 'owner-a'); invalidated.push(resource ?? '*'); } } as SchoolReadCache;
  let authorizationChecks = 0;
  const f = fixture(async (client, courseId, moduleItemId) => {
    f.setCompleted(true);
    return { detail: await client.moduleActivityDetail(courseId, moduleItemId), report: 'already_completed' };
  }, durable);
  await f.reader.readCourse('owner-a', '10');
  assert.equal((await f.reader.readActivity!('owner-a', '10', '30')).detail.attendance.completed, false);
  const before = f.counts();
  const result = await createLearningxReads(f.reader).recordMaterialView!({ userId: 'owner-a' }, '10', '30', observation,
    async () => { authorizationChecks++; }) as any;
  assert.equal(result.report, 'already_completed'); assert.equal(result.activity.completed, true);
  assert.equal(result.activity.attendanceStatus, 'none'); assert.equal(result.activity.moduleItemId, '30');
  assert.equal(authorizationChecks, 4);
  assert.equal(f.counts().catalogReads, before.catalogReads + 1);
  assert.deepEqual(invalidated, ['course:10', 'activity:10:30', 'calendar-modules:10', 'tasks', 'attendance', 'attendance:10']);
  await f.reader.readCourse('owner-a', '10');
  const refreshed = await f.reader.readActivity!('owner-a', '10', '30');
  assert.equal(refreshed.detail.attendance.completed, true);
  assert.equal(f.counts().courseReads, before.courseReads + 2);
  assert.equal(f.counts().activityReads, before.activityReads + 2);
});

test('already-completed reports require bound, open progress-enabled PDF detail and an unused write gate', async () => {
  const invalid = [detail(false), detail(null), { ...detail(true), resourceType: 'movie' },
    { ...detail(true), courseId: 'other-course' }, { ...detail(true), moduleItemId: 'other-item' },
    { ...detail(true), itemContentType: 'other' }, { ...detail(true), published: false },
    { ...detail(true), opened: false }, { ...detail(true), omitProgress: true },
    { ...detail(true), omitProgress: null }, { ...detail(true), omitProgress: undefined }];
  for (const result of invalid) {
    const f = fixture(async () => ({ detail: result, report: 'already_completed' }));
    await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error =>
      error instanceof AppError && error.statusCode === 502);
  }
  let gates = 0;
  const attempted = fixture(async (_client, _course, _item, _seen, beforeWrite) => {
    await beforeWrite(); gates++; return { detail: detail(true), report: 'already_completed' };
  });
  await assert.rejects(attempted.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error =>
    error instanceof AppError && error.statusCode === 502);
  assert.equal(gates, 1);
});

test('public already-completed projection rejects unverified completion, ownership and PDF availability', async () => {
  for (const result of [detail(false), detail(null), { ...detail(true), courseId: 'other-course' },
    { ...detail(true), moduleItemId: 'other-item' }, { ...detail(true), resourceType: 'file' },
    { ...detail(true), itemContentType: 'other' }, { ...detail(true), published: false },
    { ...detail(true), opened: false }, { ...detail(true), omitProgress: true }]) {
    const reader = { recordMaterialView: async () => ({ detail: result, report: 'already_completed', observedAt: '2026-10-02T00:00:00Z' }) } as any;
    await assert.rejects(createLearningxReads(reader).recordMaterialView!({ userId: 'owner-a' }, '10', '30', observation, validate),
      error => error instanceof AppError && error.statusCode === 502);
  }
});

test('already-completed results are withheld when authorization changes during the school read or cache invalidation', async () => {
  for (const when of ['read', 'invalidation']) for (const changed of ['school', 'alms']) {
    let active = true, newer: string | undefined;
    const revoke = () => { if (changed === 'school') { f.replace('owner-a'); newer = f.states.get('owner-a'); } else active = false; };
    const durable = { get: async () => null, put: async () => true,
      delete: async () => { if (when === 'invalidation') revoke(); } } as SchoolReadCache;
    const f = fixture(async () => {
      if (when === 'read') revoke(); return { detail: detail(true), report: 'already_completed' };
    }, durable);
    await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, async () => {
      if (!active) throw new AppError(401, 'AUTH_REQUIRED', 'Synthetic logout');
    }), error => error instanceof AppError && error.code === (changed === 'school' ? 'SCHOOL_SESSION_CHANGED' : 'AUTH_REQUIRED'));
    if (changed === 'school') assert.equal(f.states.get('owner-a'), newer);
  }
});

test('failed invalidation after fresh already-completed detail does not publish success', async () => {
  const durable = { get: async () => null, put: async () => true, delete: async () => { throw new Error('synthetic database failure'); } } as SchoolReadCache;
  const f = fixture(async () => ({ detail: detail(true), report: 'already_completed' }), durable);
  await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => {
    assert.ok(error instanceof AppError); assert.equal(error.statusCode, 502);
    assert.deepEqual(materialViewFailureDiagnostic(error), { stage: 'finalization', code: 'unknown' }); return true;
  });
});

test('a cached enrollment does not authorize a material write after the school removes access', async () => {
  let writes = 0;
  const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => { await beforeWrite(); writes++; return { detail: detail(), report: 'recorded' }; });
  await f.reader.catalog('owner-a'); f.setOwned(false);
  await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => error instanceof AppError && error.statusCode === 404);
  assert.equal(writes, 0); assert.equal(f.counts().catalogReads, 2);
});

test('new school login or ALMS logout during metadata preparation aborts before the school write', async () => {
  for (const changed of ['school', 'alms']) {
    const started = gate(), release = gate(); let writes = 0, active = true;
    const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => {
      started.release(); await release.promise; await beforeWrite(); writes++;
      return { detail: detail(), report: 'recorded' };
    });
    const operation = f.reader.recordMaterialView!('owner-a', '10', '30', observation, async () => {
      if (!active) throw new AppError(401, 'AUTH_REQUIRED', 'Synthetic logout');
    });
    await started.promise;
    if (changed === 'school') f.replace('owner-a'); else active = false;
    release.release();
    await assert.rejects(operation, error => error instanceof AppError && error.code === (changed === 'school' ? 'SCHOOL_SESSION_CHANGED' : 'AUTH_REQUIRED'));
    assert.equal(writes, 0);
  }
});

test('same concurrent observation joins one report while different pages and owners remain distinct', async () => {
  const started = gate(), release = gate(); const calls: number[] = [];
  const f = fixture(async (_client, _course, _item, seen, beforeWrite) => {
    if (calls.length === 0) { calls.push(seen.page); started.release(); await release.promise; }
    else calls.push(seen.page);
    await beforeWrite(); return { detail: detail(), report: 'recorded' };
  });
  const first = f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate); await started.promise;
  const duplicate = f.reader.recordMaterialView!('owner-a', '10', '30', { ...observation }, validate);
  const next = f.reader.recordMaterialView!('owner-a', '10', '30', { event: 'page_changed', page: 2, totalPages: 3, viewedPages: [1, 2] }, validate);
  assert.equal(first, duplicate);
  await f.reader.recordMaterialView!('owner-b', '10', '30', observation, validate);
  assert.deepEqual(calls, [1, 1]);
  release.release(); await Promise.all([first, duplicate, next]); assert.deepEqual(calls, [1, 1, 2]);
});

test('ambiguous school errors discard old completion and force the next read back to school', async () => {
  for (const old of [true, false]) {
    const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => {
      await beforeWrite(); f.setCompleted(!old); throw new SchoolError('upstream_unavailable');
    });
    f.setCompleted(old); await f.reader.readActivity!('owner-a', '10', '30'); await flush();
    await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => error instanceof AppError && error.statusCode === 502);
    const current = await f.reader.readActivity!('owner-a', '10', '30');
    assert.equal(current.detail.attendance.completed, !old);
  }
});

test('failed durable invalidation prevents a school mutation and a broken provider cannot synthesize a report', async () => {
  let writes = 0;
  const durable = { get: async () => null, put: async () => true, delete: async () => { throw new Error('synthetic DB failure'); } } as SchoolReadCache;
  const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => { await beforeWrite(); writes++; return { detail: detail(), report: 'recorded' }; }, durable);
  await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => error instanceof AppError && error.statusCode === 502);
  assert.equal(writes, 0);
  const broken = fixture(async () => ({ detail: detail(true), report: 'recorded' }));
  await assert.rejects(broken.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => error instanceof AppError && error.statusCode === 502);
});

test('school generation change after a report withholds the result and preserves the new session', async () => {
  let newer = '';
  const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => {
    await beforeWrite(); f.replace('owner-a'); newer = f.states.get('owner-a')!;
    return { detail: detail(true), report: 'recorded' };
  });
  await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  assert.equal(f.states.get('owner-a'), newer);
});

test('view report rate limits bound one owner and expire without affecting another owner', async t => {
  let clock = Date.now(), writes = 0; t.mock.method(Date, 'now', () => clock);
  const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => { await beforeWrite(); writes++; return { detail: detail(), report: 'recorded' }; });
  for (let i = 0; i < 120; i++) await f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate);
  await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => error instanceof AppError && error.statusCode === 429);
  await f.reader.recordMaterialView!('owner-b', '10', '30', observation, validate);
  clock += 60_001; await f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate);
  assert.equal(writes, 122);
});

test('SDK validation, callback and refresh evidence survives normalization without extra writes or fabricated completion', async () => {
  for (const stage of ['validation', 'callback', 'refresh'] as const) {
    let writes = 0;
    const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => {
      if (stage !== 'validation') { await beforeWrite(); writes++; }
      throw new SchoolMaterialViewError('unexpected_response', stage);
    });
    await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => {
      assert.ok(error instanceof AppError); assert.equal(error.statusCode, 502); assert.equal(error.code, 'SCHOOL_UPSTREAM_UNAVAILABLE');
      assert.deepEqual(materialViewFailureDiagnostic(error), { stage, code: 'unexpected_response' });
      assert.doesNotMatch(JSON.stringify(error), /stage|callback|refresh|diagnostic/);
      return true;
    });
    assert.equal(writes, stage === 'validation' ? 0 : 1);
  }
});

test('caller authorization errors retain their identity and diagnostics while stopping before a write', async () => {
  const denied = new AppError(401, 'AUTH_REQUIRED', 'Synthetic logout'); let checks = 0, writes = 0;
  const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => { await beforeWrite(); writes++; return { detail: detail(), report: 'recorded' }; });
  await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, async () => { if (++checks === 2) throw denied; }), error => {
    assert.equal(error, denied); assert.deepEqual(materialViewFailureDiagnostic(error), { stage: 'validation', code: 'auth_required' }); return true;
  });
  assert.equal(writes, 0);
});

test('an unstaged provider failure after the write gate remains unknown rather than guessing callback or refresh', async () => {
  for (const failure of [new SchoolError('upstream_unavailable'), new AppError(401, 'AUTH_REQUIRED', 'Synthetic authorization error')]) {
    const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => { await beforeWrite(); throw failure; });
    await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => {
      assert.deepEqual(materialViewFailureDiagnostic(error), { stage: 'unknown', code: failure instanceof SchoolError ? 'upstream_unavailable' : 'auth_required' }); return true;
    });
  }
});

test('post-report cache or session failures are finalization failures, preserving the existing failed response', async () => {
  for (const callbackFails of [false, true]) {
    let deleting = 0, writes = 0;
    // Six pre-write metadata keys (including the calendar module proof) must clear
    // before the simulated failure in the post-report finalization batch.
    const durable = { get: async () => null, put: async () => true, delete: async () => { if (++deleting > 6) throw new Error('private-database-error'); } } as SchoolReadCache;
    const f = fixture(async (_client, _course, _item, _seen, beforeWrite) => {
      await beforeWrite(); writes++;
      if (callbackFails) throw new SchoolMaterialViewError('unexpected_response', 'callback');
      return { detail: detail(true), report: 'recorded' };
    }, durable);
    await assert.rejects(f.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => {
      assert.ok(error instanceof AppError); assert.equal(error.statusCode, 502);
      assert.deepEqual(materialViewFailureDiagnostic(error), { stage: 'finalization', code: 'unknown' }); return true;
    });
    assert.equal(writes, 1);
  }
  const changed = fixture(async (_client, _course, _item, _seen, beforeWrite) => {
    await beforeWrite(); changed.replace('owner-a'); return { detail: detail(true), report: 'recorded' };
  });
  await assert.rejects(changed.reader.recordMaterialView!('owner-a', '10', '30', observation, validate), error => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'SCHOOL_SESSION_CHANGED');
    assert.deepEqual(materialViewFailureDiagnostic(error), { stage: 'finalization', code: 'session_changed' }); return true;
  });
});


test('first visible PDF returns the fresh exact module completion separately from attendance and performs no extra page read', async () => {
  let writes=0;
  const f=fixture(async (_client,_course,_module,_view,beforeWrite)=>{await beforeWrite();writes++;return {detail:detail(true),report:'recorded'};});
  f.setModuleCompleted(false);
  const first=await createLearningxReads(f.reader).recordMaterialView!({userId:'owner-a'},'10','30',observation,validate) as any;
  assert.equal(first.activity.completed,true); assert.equal(first.activity.moduleCompleted,false);
  assert.equal(f.counts().courseReads,1);
  const next=await createLearningxReads(f.reader).recordMaterialView!({userId:'owner-a'},'10','30',{...observation,event:'page_changed',page:2,viewedPages:[1,2]},validate) as any;
  assert.equal(next.activity.moduleCompleted,undefined); assert.equal(f.counts().courseReads,1);assert.equal(writes,2);
});
test('module completion is not guessed from a successful PDF acknowledgement when fresh mapping disappears', async () => {
  const f=fixture(async (_client,_course,_module,_view,beforeWrite)=>{await beforeWrite();f.setModuleId('31');return {detail:detail(true),report:'recorded'};});
  await assert.rejects(f.reader.recordMaterialView!('owner-a','10','30',observation,validate));
});
