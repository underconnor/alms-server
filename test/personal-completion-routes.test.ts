import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import type { PersonalCompletion, Session } from '../src/domain.js';
import { AppError } from '../src/errors.js';
import { unavailableSchoolProvider } from '../src/provider.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const cookie = '__Host-alms_session=' + 'a'.repeat(43);
const headers = { cookie, origin: 'https://lms.flyjung.kr', 'x-csrf-token': 'synthetic-csrf' };
const path = '/v1/courses/10/activities/90/completion';
const rawCourse = () => ({ course: { id: '10', ended: true }, weeks: [{ activities: [{ id: '90', courseId: '10', type: 'material', published: true, moduleCompleted: false }] }] });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function fixture() {
  let session: Session | null = { tokenHash: 'synthetic-hash', csrfToken: 'synthetic-csrf', expiresAt: '2099-01-01T00:00:00Z',
    analyticsSessionId: 'synthetic-session', user: { id: 'owner', displayName: null, analyticsId: 'synthetic-analytics', analyticsEnabled: true } };
  const rows = new Map<string, PersonalCompletion>();
  const calls: { operation: string; owner: string; courseId: string; activityId?: string; completed?: boolean }[] = [];
  const store = {
    getSession: async () => session,
    listCompletions: async (owner: string, courseId: string) => { calls.push({ operation: 'list', owner, courseId }); return [...rows.entries()].filter(([key, row]) => key.startsWith(owner + ':') && row.courseId === courseId).map(([, row]) => row); },
    setCompletion: async (owner: string, courseId: string, activityId: string, completed: boolean, authorization: { tokenHash: string; csrfToken: string }) => {
      assert.deepEqual(authorization, { tokenHash: 'synthetic-hash', csrfToken: 'synthetic-csrf' });
      const row = { courseId, activityId, completed, updatedAt: '2026-10-08T00:00:00.000Z' };
      calls.push({ operation: 'set', owner, courseId, activityId, completed }); rows.set(owner + ':' + courseId + ':' + activityId, row); return row;
    },
    deleteCompletion: async (owner: string, courseId: string, activityId: string) => { calls.push({ operation: 'delete', owner, courseId, activityId }); rows.delete(owner + ':' + courseId + ':' + activityId); },
  } as unknown as Store;
  return { store, calls, rows, setSession: (value: Session | null) => { session = value; }, session: () => session! };
}

test('personal completion GET reads only authenticated owner DB rows even when school authentication is unavailable', async () => {
  const f = fixture(); let schoolCalls = 0;
  f.rows.set('owner:10:90', { courseId: '10', activityId: '90', completed: false, updatedAt: '2026-10-08T00:00:00.000Z' });
  f.rows.set('other:10:90', { courseId: '10', activityId: '90', completed: true, updatedAt: '2026-10-08T00:00:00.000Z' });
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, course: async () => { schoolCalls++; throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 로그인 필요'); } });
  try {
    assert.equal((await app.inject('/v1/courses/10/completions')).statusCode, 401);
    for (const url of ['/v1/courses/10/completions?userId=other', '/v1/courses/10/completions?refresh=1', '/v1/courses/..%2F10/completions'])
      assert.equal((await app.inject({ url, headers })).statusCode, 400);
    const response = await app.inject({ url: '/v1/courses/10/completions', headers });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { items: [f.rows.get('owner:10:90')] });
    assert.deepEqual(f.calls, [{ operation: 'list', owner: 'owner', courseId: '10' }]); assert.equal(schoolCalls, 0);
    assert.doesNotMatch(response.body, /owner|token|csrf|analytics|userId/);
  } finally { await app.close(); }
});

test('personal completion true and false are durable explicit overrides; idempotent DELETE restores the default without altering school DTO', async () => {
  const f = fixture(), school = rawCourse(), original = structuredClone(school), schoolCalls: unknown[] = [];
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, course: async (context, id) => { schoolCalls.push({ context, id }); return school; } });
  try {
    for (const completed of [true, false]) {
      const response = await app.inject({ method: 'PATCH', url: path, headers, payload: { completed } });
      assert.equal(response.statusCode, 200); assert.equal(response.json().completed, completed);
      assert.equal(response.json().courseId, '10'); assert.equal(response.json().activityId, '90');
      assert.equal((await app.inject({ url: '/v1/courses/10/completions', headers })).json().items[0].completed, completed);
    }
    for (let i = 0; i < 2; i++) { const response = await app.inject({ method: 'DELETE', url: path, headers }); assert.equal(response.statusCode, 204); assert.equal(response.body, ''); }
    assert.deepEqual((await app.inject({ url: '/v1/courses/10/completions', headers })).json(), { items: [] });
    assert.deepEqual(school, original); assert.equal(schoolCalls.length, 4);
    assert.deepEqual(schoolCalls[0], { context: { userId: 'owner' }, id: '10' });
  } finally { await app.close(); }
});

test('every published module type supports personal completion independently of media or submission capabilities', async () => {
  const f = fixture(); let type = 'material';
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, course: async () => { const school = rawCourse(); school.weeks[0]!.activities[0]!.type = type; return school; } });
  try {
    for (type of ['video', 'material', 'assignment', 'quiz', 'notice', 'other'])
      assert.equal((await app.inject({ method: 'PATCH', url: path, headers, payload: { completed: true } })).statusCode, 200);
    assert.equal(f.calls.filter(call => call.operation === 'set').length, 6);
  } finally { await app.close(); }
});

test('personal completion writes enforce Origin/CSRF and strict boolean/body/path/query contracts before school or DB mutation', async () => {
  const f = fixture(); let schoolCalls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, course: async () => { schoolCalls++; return rawCourse(); } });
  try {
    for (const method of ['PATCH', 'DELETE'] as const) {
      const payload = method === 'PATCH' ? { completed: true } : undefined;
      assert.equal((await app.inject({ method, url: path, payload })).statusCode, 401);
      for (const invalid of [{ cookie }, { ...headers, origin: 'https://foreign.test' }, { ...headers, 'x-csrf-token': 'incorrect' }])
        assert.equal((await app.inject({ method, url: path, headers: invalid, payload })).statusCode, 403);
      assert.equal((await app.inject({ method, url: path + '?userId=other', headers, payload })).statusCode, 400);
      assert.equal((await app.inject({ method, url: '/v1/courses/10/activities/..%2F90/completion', headers, payload })).statusCode, 400);
    }
    for (const payload of [{}, { completed: null }, { completed: 1 }, { completed: 'false' }, { completed: true, userId: 'other' }, { completed: true, sourceUrl: 'https://foreign.test' }, { completed: true, moduleCompleted: true }])
      assert.equal((await app.inject({ method: 'PATCH', url: path, headers, payload })).statusCode, 400);
    assert.equal((await app.inject({ method: 'DELETE', url: path, headers, payload: { completed: false } })).statusCode, 400);
    assert.equal(schoolCalls, 0); assert.equal(f.calls.length, 0);
  } finally { await app.close(); }
});

test('visible assignment modules without publication metadata support personal set/reset without altering school completion', async () => {
  for (const mode of ['null', 'absent']) {
    const f = fixture(), school = rawCourse(), activity = school.weeks[0]!.activities[0]!;
    activity.type = 'assignment'; activity.moduleCompleted = true;
    if (mode === 'null') (activity as { published: boolean | null }).published = null;
    else delete (activity as { published?: boolean }).published;
    const original = structuredClone(school);
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, course: async () => school });
    try {
      for (const completed of [true, false]) {
        const response = await app.inject({ method: 'PATCH', url: path, headers, payload: { completed } });
        assert.equal(response.statusCode, 200, mode); assert.equal(response.json().completed, completed);
      }
      assert.equal((await app.inject({ method: 'DELETE', url: path, headers })).statusCode, 204, mode);
      assert.deepEqual(f.calls.map(call => call.operation), ['set', 'set', 'delete']);
      assert.deepEqual(school, original); assert.equal(school.weeks[0]!.activities[0]!.moduleCompleted, true);
    } finally { await app.close(); }
  }
});

test('writes reject missing, duplicate, explicitly unpublished, mismatched course or activity ownership', async () => {
  for (const mode of ['missing', 'duplicate', 'unpublished', 'course-owner', 'course-id', 'invalid-dto']) {
    const f = fixture(); const school = rawCourse(); const activity = school.weeks[0]!.activities[0]!;
    if (mode === 'missing') activity.id = '91';
    if (mode === 'duplicate') school.weeks[0]!.activities.push({ ...activity });
    if (mode === 'unpublished') activity.published = false;
    if (mode === 'course-owner') activity.courseId = '20';
    if (mode === 'course-id') school.course.id = '20';
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, course: async () => mode === 'invalid-dto' ? {} : school });
    try {
      for (const method of ['PATCH', 'DELETE'] as const) {
        const response = await app.inject({ method, url: path, headers, ...(method === 'PATCH' ? { payload: { completed: true } } : {}) });
        assert.equal(response.statusCode, ['course-id', 'invalid-dto'].includes(mode) ? 503 : 404, mode);
      }
      assert.equal(f.calls.length, 0, mode);
    } finally { await app.close(); }
  }
});

test('an unavailable or rejecting school course lookup prevents personal writes but not DB-only reads', async () => {
  for (const code of [null, 'SCHOOL_AUTH_REQUIRED', 'COURSE_NOT_OWNED']) {
    const f = fixture(); const app = await buildApp(config, f.store, { ...unavailableSchoolProvider,
      ...(code ? { course: async () => { throw new AppError(code === 'SCHOOL_AUTH_REQUIRED' ? 401 : 403, code, '접근 불가'); } } : {}) });
    try {
      const response = await app.inject({ method: 'PATCH', url: path, headers, payload: { completed: true } });
      assert.equal(response.statusCode, code === 'SCHOOL_AUTH_REQUIRED' ? 401 : code ? 403 : 503);
      assert.equal(f.calls.length, 0);
      assert.equal((await app.inject({ url: '/v1/courses/10/completions', headers })).statusCode, 200);
    } finally { await app.close(); }
  }
});

test('a late course lookup cannot save/reset after logout, owner switch, or CSRF change', async () => {
  for (const method of ['PATCH', 'DELETE'] as const) for (const mode of ['logout', 'owner', 'csrf']) {
    const f = fixture(), entered = gate(), held = gate();
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, course: async () => { entered.release(); await held.promise; return rawCourse(); } });
    try {
      const pending = app.inject({ method, url: path, headers, ...(method === 'PATCH' ? { payload: { completed: true } } : {}) });
      await entered.promise; const previous = f.session();
      f.setSession(mode === 'logout' ? null : { ...previous, ...(mode === 'owner' ? { user: { ...previous.user, id: 'other' } } : { csrfToken: 'changed' }) });
      held.release(); assert.equal((await pending).statusCode, 401); assert.equal(f.calls.length, 0);
    } finally { held.release(); await app.close(); }
  }
});

test('a late DB-only list response is withheld after logout or owner switch', async () => {
  for (const mode of ['logout', 'owner']) {
    const f = fixture(), entered = gate(), held = gate();
    f.store.listCompletions = async () => { entered.release(); await held.promise; return [{ courseId: '10', activityId: '90', completed: true, updatedAt: '2026-10-08T00:00:00.000Z' }]; };
    const app = await buildApp(config, f.store);
    try {
      const pending = app.inject({ url: '/v1/courses/10/completions', headers }); await entered.promise;
      const previous = f.session(); f.setSession(mode === 'logout' ? null : { ...previous, user: { ...previous.user, id: 'other' } });
      held.release(); const response = await pending; assert.equal(response.statusCode, 401); assert.equal(response.json().items, undefined);
    } finally { held.release(); await app.close(); }
  }
});
