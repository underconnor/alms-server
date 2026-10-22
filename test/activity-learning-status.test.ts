import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import type { SchoolResult } from '../src/domain.js';
import { AppError } from '../src/errors.js';
import { unavailableSchoolProvider } from '../src/provider.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
const path = '/v1/courses/10/activities/90/learning-status';
const fresh = (): SchoolResult => ({ observedAt: new Date().toISOString(), progressPercent: 100, attendance: 'unknown', recognized: null });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  let owner: string | null = 'owner', jobCalls = 0;
  const store = { getSession: async () => owner ? { tokenHash: 'session', user: { id: owner } } : null,
    getJob: async () => { jobCalls++; throw new Error('No jobs needed'); },
    createJob: async () => { jobCalls++; throw new Error('No writes'); },
    transitionJob: async () => { jobCalls++; throw new Error('No writes'); },
  } as unknown as Store;
  return { store, setOwner: (value: string | null) => { owner = value; }, jobCalls: () => jobCalls };
}

test('explicit activity checks read fresh school evidence without requiring or modifying a job', async () => {
  const f = fixture(); let calls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async (context, target, signal) => {
    calls++; assert.deepEqual(context, { userId: 'owner' }); assert.deepEqual(target, { courseId: '10', lectureId: '90' });
    assert.equal(signal?.aborted, false); return { ...fresh(), privateSource: 'private-marker' };
  } });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 200);
      const body = response.json(); assert.equal(body.courseId, '10'); assert.equal(body.activityId, '90');
      assert.equal(body.stateChanged, false); assert.equal(body.schoolResult.recognized, null);
      assert.equal(response.headers['cache-control'], 'no-store'); assert.doesNotMatch(response.body, /private-marker|userId|tokenHash/);
    }
    assert.equal(calls, 2); assert.equal(f.jobCalls(), 0);
  } finally { await app.close(); }
});

test('activity checks reject unauthenticated, malformed and unsupported requests before school access', async () => {
  const f = fixture(); let calls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { calls++; return fresh(); } });
  try {
    assert.equal((await app.inject(path)).statusCode, 401);
    for (const url of [path + '?refresh=1', path.replace('/10/', '/0/'), path.replace('/90/', '/module:90/'), path.replace('/90/', '/99999999999999999/')])
      assert.equal((await app.inject({ url, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: path, headers })).statusCode, 404);
    assert.equal(calls, 0); assert.equal(f.jobCalls(), 0);
  } finally { await app.close(); }
});

test('unavailable provider and invalid school recognition never become successful learning evidence', async () => {
  for (const mode of ['missing', 'recognized', 'bad-result', 'forbidden']) {
    const f = fixture(); const app = await buildApp(config, f.store, { ...unavailableSchoolProvider,
      ...(mode === 'missing' ? {} : { learningStatus: async () => {
        if (mode === 'forbidden') throw new AppError(403, 'FORBIDDEN', '확인할 수 없습니다.');
        return { ...fresh(), ...(mode === 'recognized' ? { recognized: true } : { progressPercent: 101 }) };
      } }),
    });
    try { const response = await app.inject({ url: path, headers });
      assert.equal(response.statusCode, mode === 'missing' ? 503 : mode === 'forbidden' ? 403 : 502);
      assert.equal(response.json().schoolResult, undefined); assert.equal(f.jobCalls(), 0);
    } finally { await app.close(); }
  }
});

test('logout or account replacement during a school read withholds the late result', async () => {
  for (const owner of [null, 'different-owner']) {
    const f = fixture(), wait = gate();
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { await wait.promise; return fresh(); } });
    try { const pending = app.inject({ url: path, headers }); await flush(); f.setOwner(owner); wait.release();
      const response = await pending; assert.equal(response.statusCode, 401); assert.equal(response.json().schoolResult, undefined);
      assert.equal(f.jobCalls(), 0);
    } finally { wait.release(); await app.close(); }
  }
});

test('concurrent and frequent same-owner reads are bounded, with capacity released after completion', async () => {
  const f = fixture(), wait = gate(); let calls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { calls++; await wait.promise; return fresh(); } });
  try {
    const first = app.inject({ url: path, headers }); await flush();
    const duplicate = await app.inject({ url: path, headers }); assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'LEARNING_STATUS_BUSY'); assert.equal(calls, 1);
    wait.release(); assert.equal((await first).statusCode, 200);
    for (let i = 0; i < 11; i++) assert.equal((await app.inject({ url: path, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: path, headers })).statusCode, 429); assert.equal(calls, 12);
  } finally { wait.release(); await app.close(); }
});

test('the full deadline bounds initial/final session reads and a provider that returns late', async t => {
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 25 : ms));
  for (const at of ['initial', 'provider', 'final']) {
    const f = fixture(), wait = gate(), original = f.store.getSession.bind(f.store); let reads = 0, signal: AbortSignal | undefined;
    f.store.getSession = async token => { reads++; if (at === 'initial' && reads === 1 || at === 'final' && reads === 3) await wait.promise; return original(token); };
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async (_context, _target, value) => {
      signal = value; if (at === 'provider') await wait.promise; return fresh();
    } });
    const alive = setTimeout(() => {}, 200);
    try { const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 503, at);
      assert.equal(response.json().error.code, 'SCHOOL_RESULT_UNAVAILABLE'); if (signal) assert.equal(signal.aborted, true);
      wait.release(); await flush(); assert.equal(f.jobCalls(), 0);
    } finally { wait.release(); clearTimeout(alive); await app.close(); }
  }
});

test('a stalled ALMS database read is capped independently of the school deadline', async t => {
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 5_000 ? 20 : ms));
  const f = fixture(), wait = gate(), original = f.store.getSession.bind(f.store); let calls = 0;
  f.store.getSession = async token => { await wait.promise; return original(token); };
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { calls++; return fresh(); } });
  const alive = setTimeout(() => {}, 100);
  try { const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 503);
    wait.release(); await flush(); assert.equal(calls, 0);
  } finally { wait.release(); clearTimeout(alive); await app.close(); }
});

test('client disconnect aborts the school read and withholds a later result', async () => {
  const f = fixture(), wait = gate(); let received: AbortSignal | undefined, stop!: () => void;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async (_context, _target, signal) => { received = signal; await wait.promise; return fresh(); } });
  app.addHook('preHandler', async request => { stop = () => request.raw.emit('aborted'); });
  try { const pending = app.inject({ url: path, headers }); await flush(); stop(); const response = await pending;
    assert.equal(response.statusCode, 503); assert.equal(received?.aborted, true); wait.release(); await flush(); assert.equal(f.jobCalls(), 0);
  } finally { wait.release(); await app.close(); }
});

test('activity verification awaits an exact owner/target cache refresh and preserves the read-only DTO', async () => {
  const f = fixture(), held = gate(), entered = gate(), raw = { ...fresh(), progressPercent: null }; let resolved = false, refreshes = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => raw,
    refreshLearningStatus: async (context, target, result, options) => {
      refreshes++; assert.deepEqual(context, { userId: 'owner' }); assert.deepEqual(target, { courseId: '10', lectureId: '90' });
      assert.equal(result, raw); await options.validate(); entered.release(); await held.promise; await options.validate();
    },
  });
  try {
    const request = app.inject({ url: path, headers }).then(value => { resolved = true; return value; });
    await entered.promise; assert.equal(resolved, false); held.release(); const response = await request;
    assert.equal(response.statusCode, 200); assert.equal(refreshes, 1); assert.equal(response.json().stateChanged, false);
    assert.equal(response.json().schoolResult.progressPercent, null); assert.equal(response.json().schoolResult.recognized, null);
    assert.equal(f.jobCalls(), 0); assert.doesNotMatch(response.body, /generation|tokenHash|userId/);
  } finally { held.release(); await app.close(); }
});

test('failed or invalid activity reads never refresh caches and refresh failure withholds the school result', async () => {
  for (const mode of ['read-error', 'invalid', 'refresh-error']) {
    const f = fixture(); let refreshes = 0;
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider,
      learningStatus: async () => { if (mode === 'read-error') throw new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '조회 실패');
        return { ...fresh(), ...(mode === 'invalid' ? { recognized: true as unknown as null } : {}) }; },
      refreshLearningStatus: async () => { refreshes++; throw new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '갱신 실패'); },
    });
    try { const response = await app.inject({ url: path, headers });
      assert.equal(response.statusCode, mode === 'invalid' ? 502 : 503); assert.equal(response.json().schoolResult, undefined);
      assert.equal(refreshes, mode === 'refresh-error' ? 1 : 0); assert.equal(f.jobCalls(), 0);
    } finally { await app.close(); }
  }
});

test('activity verification requires the final ALMS session while cache refresh completes', async () => {
  for (const owner of [null, 'different-owner']) {
    const f = fixture();
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => fresh(),
      refreshLearningStatus: async (_context, _target, _result, options) => { f.setOwner(owner); await options.validate(); },
    });
    try { const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 401);
      assert.equal(response.json().schoolResult, undefined); assert.equal(f.jobCalls(), 0);
    } finally { await app.close(); }
  }
});
