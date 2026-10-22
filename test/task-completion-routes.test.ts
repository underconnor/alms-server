import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../src/errors.js';

const cookie = '__Host-alms_session=' + 'a'.repeat(43);
const gate = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};};
async function fixture() {
  let active = true; const calls: unknown[] = [];
  const session = {user: {id: 'owner-a'}, tokenHash: 'synthetic-session'};
  const rows = [{courseId: '10', activityId: '90', completed: false, updatedAt: '2026-10-10T00:00:00Z'},
    {courseId: '20', activityId: '90', completed: true, updatedAt: '2026-10-10T00:00:00Z'}];
  const store = {getSession: async () => active ? session : null,
    listCompletionsForCourses: async (owner: string, courses: string[]) => {calls.push({owner, courses}); return rows;}} as unknown as Store;
  const value = {items: [{id: 'task-a', courseId: '10', moduleItemId: '90', weekId: '40', assignmentId: '31', moduleCompleted: true, schoolStatus: null},
    {id: 'task-b', courseId: '20', moduleItemId: '90', moduleCompleted: false, schoolStatus: null},
    {id: 'hashed-task', courseId: '10', assignmentId: '32', schoolStatus: null}], courses: [{id: '10', todoCounts: {total_unsubmitted_assignments: 2}}]};
  const provider = {...unavailableSchoolProvider, tasks: async (context: {userId: string}) => {calls.push({schoolOwner: context.userId}); return value;},
    validateTasks: async (context: {userId: string; sessionTokenHash: string}, result: unknown) => {
      assert.equal(context.userId, 'owner-a'); assert.equal(context.sessionTokenHash, session.tokenHash); assert.equal(result, value);
      if (!active) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    }};
  const app = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent'}), store, provider);
  return {app, store, provider, calls, value, revoke: () => {active = false;}};
}

test('TODO uses one authenticated owner batch for verified module links and preserves school/assignment status', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/v1/tasks')).statusCode, 401); assert.deepEqual(f.calls, []);
    for (const query of ['userId=owner-b', 'courseId=20', 'refresh=1'])
      assert.equal((await f.app.inject({url: '/v1/tasks?' + query, headers: {cookie}})).statusCode, 400);
    assert.deepEqual(f.calls, []);
    const response = await f.app.inject({url: '/v1/tasks', headers: {cookie}});
    assert.equal(response.statusCode, 200);
    const value = response.json();
    assert.equal(value.items[0].personalCompleted, false); assert.equal(value.items[0].moduleCompleted, true);
    assert.equal(value.items[0].schoolStatus, null); assert.equal(value.items[0].assignmentId, '31'); assert.equal(value.items[0].weekId, '40');
    assert.equal(value.items[1].personalCompleted, true); assert.equal(value.items[1].moduleCompleted, false);
    assert.equal(value.items[2].personalCompleted, undefined); assert.equal(value.items[2].moduleItemId, undefined);
    assert.deepEqual(value.courses, f.value.courses);
    assert.deepEqual(f.calls, [{schoolOwner: 'owner-a'}, {owner: 'owner-a', courses: ['10', '20']}]);
    assert.equal((f.value.items[0] as any).personalCompleted, undefined);
  } finally {await f.app.close();}
});

test('unmapped cold TODO never reads completion storage or uses a hashed task ID as an activity', async () => {
  const f = await fixture();
  f.value.items.splice(0, 2);
  try {
    const response = await f.app.inject({url: '/v1/tasks', headers: {cookie}});
    assert.equal(response.statusCode, 200); assert.deepEqual(f.calls, [{schoolOwner: 'owner-a'}]);
    assert.equal(response.json().items[0].personalCompleted, undefined);
  } finally {await f.app.close();}
});

test('Commons TODO preserves explicit personal false over school completion and reset null with the same verified module link', async () => {
  const f = await fixture();
  const task = f.value.items[0] as any;
  delete task.assignmentId; task.type = 'video';
  try {
    const first = await f.app.inject({url: '/v1/tasks', headers: {cookie}});
    assert.equal(first.statusCode, 200); const before = first.json().items[0];
    assert.equal(before.personalCompleted, false); assert.equal(before.moduleCompleted, true);
    assert.equal(before.weekId, '40'); assert.equal(before.moduleItemId, '90'); assert.equal(before.assignmentId, undefined);
    f.store.listCompletionsForCourses = async () => [];
    const next = await f.app.inject({url: '/v1/tasks', headers: {cookie}});
    assert.equal(next.statusCode, 200); const after = next.json().items[0];
    assert.equal(after.personalCompleted, null); assert.equal(after.moduleCompleted, true);
    assert.equal(after.id, before.id); assert.equal(after.schoolStatus, null);
  } finally {await f.app.close();}
});

test('logout while completion batch is pending rejects the old private response', async () => {
  const f = await fixture(), entered = gate(), held = gate();
  f.store.listCompletionsForCourses = async () => {entered.release(); await held.promise; return [{courseId: '10', activityId: '90', completed: true, updatedAt: '2026-10-10T00:00:00Z'}];};
  try {
    const pending = f.app.inject({url: '/v1/tasks', headers: {cookie}});
    await entered.promise; f.revoke(); held.release();
    assert.equal((await pending).statusCode, 401);
  } finally {held.release(); await f.app.close();}
});

test('logout while the final school generation validation awaits rejects the old private response', async () => {
  const f = await fixture(), entered = gate(), held = gate();
  const validate = f.provider.validateTasks;
  f.provider.validateTasks = async (context, result) => {
    assert.equal(context.userId, 'owner-a'); assert.equal(result, f.value);
    entered.release(); await held.promise;
    await validate(context, result);
  };
  try {
    const pending = f.app.inject({url: '/v1/tasks', headers: {cookie}});
    await entered.promise; f.revoke(); held.release();
    const response = await pending;
    assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'AUTH_REQUIRED');
    assert.equal(response.json().items, undefined);
  } finally {held.release(); await f.app.close();}
});

test('providers without final generation validation may read unmapped TODO but cannot overlay module links', async () => {
  const f = await fixture();
  delete (f.provider as {validateTasks?: unknown}).validateTasks;
  try {
    const blocked = await f.app.inject({url: '/v1/tasks', headers: {cookie}});
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error.code, 'SCHOOL_PROVIDER_UNAVAILABLE');
    assert.deepEqual(f.calls, [{schoolOwner: 'owner-a'}]);
    f.value.items.splice(0, 2); f.calls.length = 0;
    const cold = await f.app.inject({url: '/v1/tasks', headers: {cookie}});
    assert.equal(cold.statusCode, 200); assert.deepEqual(f.calls, [{schoolOwner: 'owner-a'}]);
    assert.equal(cold.json().items[0].personalCompleted, undefined);
  } finally {await f.app.close();}
});

test('same-owner school login during a completion batch rejects the old mapped TODO even while its ALMS session stays valid', async () => {
  const key = randomBytes(32), entered = gate(), held = gate();
  const seal = () => encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, 'owner-a', 'ssu');
  let encrypted = seal();
  const session = {user: {id: 'owner-a'}, tokenHash: 'synthetic-session'};
  const store = {getSession: async () => session,
    getEncryptedSchoolSession: async () => encrypted,
    getAuthenticatedSchoolSession: async (owner: string, provider: string, tokenHash: string) => {
      assert.equal(owner, 'owner-a'); assert.equal(provider, 'ssu'); assert.equal(tokenHash, session.tokenHash);
      return {almsSessionValid: true, encryptedSchoolSession: encrypted};
    },
    replaceEncryptedSchoolSession: async (_owner: string, _provider: string, before: string, after: string) => {
      if (encrypted !== before) return false; encrypted = after; return true;
    },
    listCompletionsForCourses: async (owner: string, courses: string[]) => {
      assert.equal(owner, 'owner-a'); assert.deepEqual(courses, ['10']);
      entered.release(); await held.promise;
      return [{courseId: '10', activityId: '90', completed: false, updatedAt: '2026-10-10T00:00:00Z'}];
    }} as unknown as Store;
  const reader = createLearningxReader(store, key, async () => ({serialize: async () => ({}), client: {
    terms: async () => [{id: 'term', name: '합성 학기', isDefault: true}],
    courses: async () => [{id: '10', name: '합성 강좌', termId: 'term'}],
    modules: async () => [{id: '40', title: '합성 주차', week: 1, items: [{id: '90', assignmentId: '31', title: '합성 과제', contentType: 'assignment', completed: true}]}],
    todos: async () => [{courseId: '10', activities: {}, items: [{title: '합성 TODO', componentType: 'assignment', commonsType: null,
      componentId: '12', assignmentId: '31', quizId: null, discussionId: null, sectionId: '13', unitId: '14', dueAt: null, sourceUrl: null}]}],
  } as any}));
  await reader.readCourse('owner-a', '10');
  const app = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent'}), store,
    {...unavailableSchoolProvider, ...createLearningxReads(reader)});
  try {
    const pending = app.inject({url: '/v1/tasks', headers: {cookie}});
    await entered.promise; encrypted = seal();
    assert.equal(await store.getSession('synthetic-session'), session);
    held.release();
    const response = await pending;
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'SCHOOL_SESSION_CHANGED');
    assert.equal(response.json().items, undefined);
  } finally {held.release(); await app.close();}
});

test('the final atomic authority snapshot distinguishes late school replacement, ALMS logout, and missing school state without a later getSession read', async () => {
  for (const scenario of ['school_replaced', 'alms_revoked', 'school_missing'] as const) {
    const key = randomBytes(32), entered = gate(), held = gate(); let active = true, sessionReads = 0, snapshots = 0, readsAtSnapshot = 0;
    const seal = () => encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, 'owner-a', 'ssu');
    let encrypted: string | null = seal();
    const session = {user: {id: 'owner-a'}, tokenHash: 'synthetic-session'};
    const store = {getSession: async () => {sessionReads++; return active ? session : null;},
      getEncryptedSchoolSession: async () => encrypted,
      replaceEncryptedSchoolSession: async (_owner: string, _provider: string, before: string, after: string) => {
        if (encrypted !== before) return false; encrypted = after; return true;
      },
      getAuthenticatedSchoolSession: async (owner: string, provider: string, tokenHash: string) => {
        assert.equal(owner, 'owner-a'); assert.equal(provider, 'ssu'); assert.equal(tokenHash, session.tokenHash);
        snapshots++; readsAtSnapshot = sessionReads; entered.release(); await held.promise;
        return {almsSessionValid: active, encryptedSchoolSession: encrypted};
      },
      listCompletionsForCourses: async () => [{courseId: '10', activityId: '90', completed: false, updatedAt: '2026-10-10T00:00:00Z'}],
    } as unknown as Store;
    const reader = createLearningxReader(store, key, async () => ({serialize: async () => ({}), client: {
      terms: async () => [{id: 'term', name: '합성 학기', isDefault: true}], courses: async () => [{id: '10', name: '합성 강좌', termId: 'term'}],
      modules: async () => [{id: '40', title: '합성 주차', week: 1, items: [{id: '90', assignmentId: '31', title: '합성 과제', contentType: 'assignment', completed: true}]}],
      todos: async () => [{courseId: '10', activities: {}, items: [{title: '합성 TODO', componentType: 'assignment', commonsType: null,
        componentId: '12', assignmentId: '31', quizId: null, discussionId: null, sectionId: '13', unitId: '14', dueAt: null, sourceUrl: null}]}],
    } as any}));
    await reader.readCourse('owner-a', '10');
    const app = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent'}), store,
      {...unavailableSchoolProvider, ...createLearningxReads(reader)});
    try {
      const pending = app.inject({url: '/v1/tasks', headers: {cookie}}); await entered.promise;
      if (scenario === 'school_replaced') encrypted = seal();
      if (scenario === 'alms_revoked') active = false;
      if (scenario === 'school_missing') encrypted = null;
      held.release(); const response = await pending;
      assert.equal(response.statusCode, scenario === 'school_replaced' ? 409 : 401, scenario);
      assert.equal(response.json().error.code, scenario === 'school_replaced' ? 'SCHOOL_SESSION_CHANGED'
        : scenario === 'alms_revoked' ? 'AUTH_REQUIRED' : 'SCHOOL_AUTH_REQUIRED', scenario);
      assert.equal(response.json().items, undefined); assert.ok(readsAtSnapshot >= 1);
      assert.equal(sessionReads, readsAtSnapshot); assert.equal(snapshots, 1);
    } finally {held.release(); await app.close();}
  }
});
