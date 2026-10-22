import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { unavailableSchoolProvider } from '../../src/provider.js';
import { createLearningxReader } from '../../src/school-reader.js';
import { createLearningxReads } from '../../src/school-read.js';
import { encryptSchoolSession } from '../../src/crypto.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !['/alms_test', '/alms_qa'].includes(new URL(databaseUrl).pathname)) throw new Error('Use an isolated alms_test or alms_qa database');
const path = '/v1/courses/10/activities/90/completion';
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
describe('durable personal completion in isolated PostgreSQL', { skip: !databaseUrl }, () => {
  let pool: Pool, store: PgStore;
  const owners: string[] = [];
  const identity = { provider: 'personal-completion-integration', subject: randomUUID() };
  type Issued = Awaited<ReturnType<PgStore['issueVerifiedSession']>>;
  let a: Issued, b: Issued;
  const authorization = (session: Issued) => ({ tokenHash: hashToken(session.token), csrfToken: session.csrfToken });
  const headers = (session: Issued) => ({ cookie: '__Host-alms_session=' + session.token, origin: 'https://lms.flyjung.kr', 'x-csrf-token': session.csrfToken });
  const school = { ...unavailableSchoolProvider, course: async () => ({ course: { id: '10', ended: true }, weeks: [{ activities: [{ id: '90', courseId: '10', published: true, type: 'material', moduleCompleted: true }] }] }) };
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5, statement_timeout: 5000, application_name: 'alms-test-completion' });
    await migrate(pool); await migrate(pool); store = new PgStore(pool); await store.health();
    a = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => 'synthetic-school-generation-one' });
    b = await store.issueVerifiedSession({ ...identity, subject: randomUUID() }, 3600); owners.push(a.user.id, b.user.id);
  });
  after(async () => { if (pool) { await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); await pool.end(); } });

  it('the migration is applied once and readiness refuses a database missing completion storage', async () => {
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='011-playback-job-settlement.sql'")).rowCount, 1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("DELETE FROM schema_migrations WHERE name='011-playback-job-settlement.sql'");
      const transactionStore = new PgStore({ query: client.query.bind(client) } as unknown as Pool);
      await assert.rejects(transactionStore.health(), /migrations are pending/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('true and false are separate persistent overrides scoped to owner, course and activity', async () => {
    await store.setCompletion(a.user.id, '10', '90', true, authorization(a));
    await store.setCompletion(a.user.id, '20', '90', true, authorization(a));
    await store.setCompletion(b.user.id, '10', '90', false, authorization(b));
    const row = await store.setCompletion(a.user.id, '10', '90', false, authorization(a));
    assert.deepEqual(Object.keys(row).sort(), ['activityId', 'completed', 'courseId', 'updatedAt']);
    assert.equal(row.completed, false); assert.ok(Number.isFinite(Date.parse(row.updatedAt)));
    assert.equal((await store.listCompletions(a.user.id, '10')).length, 1);
    assert.equal((await store.listCompletions(a.user.id, '20'))[0]!.completed, true);
    assert.equal((await store.listCompletions(b.user.id, '10'))[0]!.completed, false);
    assert.equal((await pool.query('SELECT 1 FROM personal_learning_completions WHERE user_id=$1 AND course_id=$2 AND activity_id=$3', [a.user.id, '10', '90'])).rowCount, 1);
  });

  it('batch TODO reads use the owner and exact requested courses while retaining explicit false', async () => {
    const rows = await store.listCompletionsForCourses(a.user.id, ['10', '10', '20']);
    assert.deepEqual(rows.map(row => [row.courseId, row.activityId, row.completed]), [['10', '90', false], ['20', '90', true]]);
    assert.deepEqual((await store.listCompletionsForCourses(b.user.id, ['10'])).map(row => [row.courseId, row.activityId, row.completed]), [['10', '90', false]]);
    assert.deepEqual(await store.listCompletionsForCourses(a.user.id, ['99']), []);
    assert.deepEqual(await store.listCompletionsForCourses(a.user.id, []), []);
    await assert.rejects(store.listCompletionsForCourses(a.user.id, ['../10']), (error: any) => error.code === 'INVALID_REQUEST');
    await assert.rejects(store.listCompletionsForCourses(a.user.id, Array.from({length: 101}, (_, index) => String(index + 1))), (error: any) => error.code === 'INVALID_REQUEST');
  });

  it('a single final TODO SQL snapshot rejects late same-owner school replacement while preserving ALMS/school authority distinctions', async () => {
    const key = randomBytes(32), entered = gate(), held = gate();
    const testIdentity = {...identity, subject: randomUUID()};
    const seal = (owner: string) => encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, owner, 'ssu');
    const first = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal}); owners.push(first.user.id);
    await store.setCompletion(first.user.id, '10', '90', false, authorization(first));
    const requestStore = new PgStore(pool);
    const reader = createLearningxReader(requestStore, key, async () => ({serialize: async () => ({}), client: {
      terms: async () => [{id: 'term', name: '합성 학기', isDefault: true}], courses: async () => [{id: '10', name: '합성 강좌', termId: 'term'}],
      modules: async () => [{id: '40', title: '합성 주차', week: 1, items: [{id: '90', assignmentId: '31', title: '합성 과제', contentType: 'assignment', completed: true}]}],
      todos: async () => [{courseId: '10', activities: {}, items: [{title: '합성 TODO', componentType: 'assignment', commonsType: null,
        componentId: '12', assignmentId: '31', quizId: null, discussionId: null, sectionId: '13', unitId: '14', dueAt: null, sourceUrl: null}]}],
    } as any}));
    await reader.readCourse(first.user.id, '10');
    const snapshot = requestStore.getAuthenticatedSchoolSession.bind(requestStore);
    let snapshots = 0;
    requestStore.getAuthenticatedSchoolSession = async (owner, provider, tokenHash) => {
      assert.equal(owner, first.user.id); assert.equal(provider, 'ssu'); assert.equal(tokenHash, hashToken(first.token));
      snapshots++; entered.release(); await held.promise; return snapshot(owner, provider, tokenHash);
    };
    const app = await buildApp(loadConfig({DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent'}), requestStore,
      {...unavailableSchoolProvider, ...createLearningxReads(reader)});
    try {
      const pending = app.inject({url: '/v1/tasks', headers: headers(first)}); await entered.promise;
      const second = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal});
      assert.equal(second.user.id, first.user.id); assert.ok(await store.getSession(hashToken(first.token)));
      held.release(); const response = await pending;
      assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'SCHOOL_SESSION_CHANGED');
      assert.equal(response.json().items, undefined); assert.equal(snapshots, 1);
      assert.equal((await store.listCompletions(first.user.id, '10'))[0]!.completed, false);
      const current = await snapshot(first.user.id, 'ssu', hashToken(first.token));
      assert.equal(current.almsSessionValid, true); assert.ok(current.encryptedSchoolSession);
      assert.equal((await snapshot(b.user.id, 'ssu', hashToken(first.token))).almsSessionValid, false);
      assert.deepEqual(await snapshot(first.user.id, 'missing-provider', hashToken(first.token)), {almsSessionValid: true, encryptedSchoolSession: null});
      await store.deleteSession(hashToken(first.token));
      const loggedOut = await snapshot(first.user.id, 'ssu', hashToken(first.token));
      assert.equal(loggedOut.almsSessionValid, false); assert.equal(loggedOut.encryptedSchoolSession, current.encryptedSchoolSession);
      await pool.query('UPDATE sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE token_hash=$1', [hashToken(second.token)]);
      assert.equal((await snapshot(first.user.id, 'ssu', hashToken(second.token))).almsSessionValid, false);
    } finally {held.release(); await app.close();}
  });

  it('cold Commons TODO keeps durable true/false across relogin and loads only its own override course', async () => {
    const key = randomBytes(32), subject = randomUUID();
    const seal = (owner: string) => encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, owner, 'ssu');
    const testIdentity = {...identity, subject};
    let current = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal}); owners.push(current.user.id);
    await store.setCompletion(current.user.id, '10', '90', false, authorization(current));
    let moduleCalls = 0;
    const create = () => createLearningxReader(store, key, async () => ({serialize: async () => ({}), client: {
      terms: async () => [{id: '1', name: '합성 학기', isDefault: true}],
      courses: async () => ['10', '20'].map(id => ({id, name: '합성 강좌 ' + id, termId: '1', usePureCanvas: true})),
      modules: async (courseId: string) => {assert.equal(courseId, '10'); moduleCalls++; return [{id: '40', title: '합성 주차', week: 1, items: [
        {id: '90', contentType: 'attendance_item', itemContentType: 'commons', attendanceItemId: '12', resourceType: 'movie',
          activityDetailAvailable: true, completed: true, published: true}]}];},
      todos: async () => ['10', '20'].map(courseId => ({courseId, activities: {}, items: [{title: '합성 TODO', componentType: 'commons', commonsType: 'movie',
        componentId: '12', assignmentId: null, quizId: null, discussionId: null, sectionId: '13', unitId: '14', dueAt: null, sourceUrl: null}]})),
    } as any}), undefined, undefined, undefined, null);
    const config = loadConfig({DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent'});
    const read = async () => {
      const app = await buildApp(config, store, {...unavailableSchoolProvider, ...createLearningxReads(create())});
      try {const value = await app.inject({url: '/v1/tasks', headers: headers(current)}); assert.equal(value.statusCode, 200); return value.json();}
      finally {await app.close();}
    };
    const first = await read();
    assert.equal(first.items.find((item: any) => item.courseId === '10').personalCompleted, false);
    assert.equal(first.items.find((item: any) => item.courseId === '20').moduleItemId, undefined); assert.equal(moduleCalls, 1);
    await store.deleteSession(hashToken(current.token)); current = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal});
    const relogin = await read(); assert.equal(relogin.items.find((item: any) => item.courseId === '10').personalCompleted, false);
    assert.equal(relogin.items.find((item: any) => item.courseId === '10').moduleCompleted, true); assert.equal(moduleCalls, 2);
    await store.setCompletion(current.user.id, '10', '90', true, authorization(current));
    assert.equal((await read()).items.find((item: any) => item.courseId === '10').personalCompleted, true); assert.equal(moduleCalls, 3);
    await store.deleteCompletion(current.user.id, '10', '90', authorization(current));
    const reset = await read(); assert.equal(reset.items.find((item: any) => item.courseId === '10').moduleItemId, undefined); assert.equal(moduleCalls, 3);
    assert.equal(reset.items.find((item: any) => item.courseId === '10').schoolStatus, null);
  });

  it('calendar completion uses durable own overrides after a cold read and relogin without depending on pending school TODO', async () => {
    const key = randomBytes(32), subject = randomUUID();
    const seal = (owner: string) => encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, owner, 'ssu');
    const testIdentity = {...identity, subject};
    let current = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal}); owners.push(current.user.id);
    const other = await store.issueVerifiedSession({...identity, subject: randomUUID()}, 3600, {provider: 'ssu', seal}); owners.push(other.user.id);
    await store.setCompletion(current.user.id, '10', '90', false, authorization(current));
    const calls = {modules: 0, todos: 0};
    const create = () => createLearningxReader(store, key, async () => ({serialize: async () => ({}), client: {
      terms: async () => [{id: '1', name: '합성 학기', isDefault: true}], courses: async () => [{id: '10', name: '합성 강좌', termId: '1'}],
      calendar: async (query: unknown) => ({...query as object, timeZone: 'Asia/Seoul', courses: [{id: '10', title: '합성 강좌'}], complete: true,
        items: [{id: 'assignment_31', type: 'assignment', courseId: '10', title: '합성 과제', startsAt: '2099-10-10T00:00:00Z', endsAt: '2099-10-10T00:00:00Z',
          dueAt: '2099-10-10T00:00:00Z', allDay: false, allDayDate: null, assignmentId: '31', sourceUrl: null, userSubmitted: true}]}),
      modules: async () => {calls.modules++; return [{id: '40', title: '합성 주차', week: 1, items: [{id: '90', contentType: 'assignment', assignmentId: '31', completed: false, published: true}]}];},
      todos: async () => {calls.todos++; throw new Error('Calendar completion must not read pending TODO');},
    } as any}), undefined, undefined, undefined, null);
    const requestUrl = '/v1/calendar?start=2099-10-01&end=2099-11-01';
    const app = await buildApp(loadConfig({DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent'}), store, {...unavailableSchoolProvider, ...createLearningxReads(create())});
    try {
      const first = await app.inject({url: requestUrl, headers: headers(current)}); assert.equal(first.statusCode, 200);
      assert.equal(first.json().items[0].personalCompleted, false); assert.equal(first.json().items[0].moduleCompleted, false); assert.equal(first.json().items[0].userSubmitted, true);
      await store.setCompletion(current.user.id, '10', '90', true, authorization(current));
      assert.equal((await app.inject({url: requestUrl, headers: headers(current)})).json().items[0].personalCompleted, true);
      const otherValue = await app.inject({url: requestUrl, headers: headers(other)}); assert.equal(otherValue.statusCode, 200);
      assert.equal(otherValue.json().items[0].moduleItemId, undefined); assert.equal(otherValue.json().items[0].userSubmitted, true); assert.equal(calls.modules, 1);
      await store.deleteSession(hashToken(current.token));
      current = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal});
      const restarted = await buildApp(loadConfig({DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent'}), store, {...unavailableSchoolProvider, ...createLearningxReads(create())});
      try {
        const value = await restarted.inject({url: requestUrl, headers: headers(current)}); assert.equal(value.statusCode, 200);
        assert.equal(value.json().items[0].personalCompleted, true); assert.equal(value.json().items[0].userSubmitted, true); assert.equal(calls.modules, 2);
        await store.deleteCompletion(current.user.id, '10', '90', authorization(current));
        assert.equal((await restarted.inject({url: requestUrl, headers: headers(current)})).json().items[0].personalCompleted, null);
        assert.equal(calls.todos, 0);
      } finally {await restarted.close();}
    } finally {await app.close();}
  });

  it('the final calendar SQL snapshot rejects a late same-owner school replacement after its completion batch', async () => {
    const key = randomBytes(32), entered = gate(), held = gate(), subject = randomUUID();
    const seal = (owner: string) => encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, owner, 'ssu');
    const testIdentity = {...identity, subject};
    const first = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal}); owners.push(first.user.id);
    await store.setCompletion(first.user.id, '10', '90', false, authorization(first));
    const requestStore = new PgStore(pool), snapshot = requestStore.getAuthenticatedSchoolSession.bind(requestStore); let snapshots = 0;
    const reader = createLearningxReader(requestStore, key, async () => ({serialize: async () => ({}), client: {
      terms: async () => [{id: '1', name: '합성 학기', isDefault: true}], courses: async () => [{id: '10', name: '합성 강좌', termId: '1'}],
      calendar: async (query: unknown) => ({...query as object, timeZone: 'Asia/Seoul', courses: [{id: '10', title: '합성 강좌'}], complete: true,
        items: [{id: 'assignment_31', type: 'assignment', courseId: '10', title: '합성 과제', startsAt: '2099-10-10T00:00:00Z', endsAt: '2099-10-10T00:00:00Z',
          dueAt: '2099-10-10T00:00:00Z', allDay: false, allDayDate: null, assignmentId: '31', sourceUrl: null, userSubmitted: true}]}),
      modules: async () => [{id: '40', title: '합성 주차', week: 1, items: [{id: '90', contentType: 'assignment', assignmentId: '31', completed: true}]}],
    } as any}), undefined, undefined, undefined, null);
    requestStore.getAuthenticatedSchoolSession = async (owner, provider, tokenHash) => {snapshots++; entered.release(); await held.promise; return snapshot(owner, provider, tokenHash);};
    const app = await buildApp(loadConfig({DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent'}), requestStore, {...unavailableSchoolProvider, ...createLearningxReads(reader)});
    try {
      const pending = app.inject({url: '/v1/calendar?start=2099-10-01&end=2099-11-01', headers: headers(first)}); await entered.promise;
      const second = await store.issueVerifiedSession(testIdentity, 3600, {provider: 'ssu', seal}); assert.equal(second.user.id, first.user.id);
      assert.ok(await store.getSession(hashToken(first.token))); held.release();
      const value = await pending; assert.equal(value.statusCode, 409); assert.equal(value.json().error.code, 'SCHOOL_SESSION_CHANGED');
      assert.equal(value.json().items, undefined); assert.equal(snapshots, 1);
      assert.equal((await store.listCompletions(first.user.id, '10'))[0]!.completed, false);
    } finally {held.release(); await app.close();}
  });

  it('a new SQL connection, school session replacement, logout and relogin preserve explicit false for the same verified identity', async () => {
    const expected = await store.listCompletions(a.user.id, '10');
    const freshPool = new Pool({ connectionString: databaseUrl, max: 1 });
    try { assert.deepEqual(await new PgStore(freshPool).listCompletions(a.user.id, '10'), expected); }
    finally { await freshPool.end(); }
    await store.deleteSession(hashToken(a.token));
    assert.equal(await store.getSession(hashToken(a.token)), null);
    assert.deepEqual(await store.listCompletions(a.user.id, '10'), expected);
    a = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => 'synthetic-school-generation-two' });
    assert.equal(a.user.id, owners[0]); assert.deepEqual(await store.listCompletions(a.user.id, '10'), expected);
    let schoolCalls = 0;
    const app = await buildApp(loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' }), store, {
      ...unavailableSchoolProvider, course: async () => { schoolCalls++; throw new Error('School must not be contacted'); },
    });
    try { const response = await app.inject({ url: '/v1/courses/10/completions', headers: headers(a) });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { items: expected }); assert.equal(schoolCalls, 0);
    } finally { await app.close(); }
  });

  it('reset is idempotent and does not change another owner or another course', async () => {
    await store.deleteCompletion(a.user.id, '10', '90', authorization(a)); await store.deleteCompletion(a.user.id, '10', '90', authorization(a));
    assert.deepEqual(await store.listCompletions(a.user.id, '10'), []);
    assert.equal((await store.listCompletions(a.user.id, '20')).length, 1);
    assert.equal((await store.listCompletions(b.user.id, '10'))[0]!.completed, false);
  });

  it('direct store calls cannot use another account, a revoked session, or a changed CSRF token for mutation', async () => {
    const revoked = await store.issueVerifiedSession(identity, 3600); await store.deleteSession(hashToken(revoked.token));
    for (const auth of [authorization(b), authorization(revoked), { ...authorization(a), csrfToken: 'changed' }]) {
      await assert.rejects(store.setCompletion(a.user.id, '10', '90', true, auth), (error: any) => error.code === 'AUTH_REQUIRED');
      await assert.rejects(store.deleteCompletion(a.user.id, '10', '90', auth), (error: any) => error.code === 'AUTH_REQUIRED');
    }
    assert.deepEqual(await store.listCompletions(a.user.id, '10'), []);
    assert.equal((await store.listCompletions(b.user.id, '10'))[0]!.completed, false);
  });

  it('logout during school authorization rejects the HTTP request before any personal SQL write', async () => {
    for (const method of ['PATCH', 'DELETE'] as const) {
      const session = await store.issueVerifiedSession(identity, 3600), entered = gate(), held = gate();
      const app = await buildApp(loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' }), store, {
        ...school, course: async () => { entered.release(); await held.promise; return school.course(); },
      });
      try {
        const pending = app.inject({ method, url: path, headers: headers(session), ...(method === 'PATCH' ? { payload: { completed: true } } : {}) });
        await entered.promise; await store.deleteSession(hashToken(session.token)); held.release();
        assert.equal((await pending).statusCode, 401); assert.deepEqual(await store.listCompletions(a.user.id, '10'), []);
      } finally { held.release(); await app.close(); }
    }
  });

  it('expiration while waiting on an existing completion row rolls back both upsert and reset', async () => {
    for (const operation of ['set', 'delete']) {
      const session = await store.issueVerifiedSession(identity, 3600);
      await store.setCompletion(a.user.id, '10', '90', false, authorization(session));
      const before = await store.listCompletions(a.user.id, '10');
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN'); await locker.query('SELECT 1 FROM personal_learning_completions WHERE user_id=$1 AND course_id=$2 AND activity_id=$3 FOR UPDATE', [a.user.id, '10', '90']);
        const expiry = (await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1 RETURNING expires_at", [hashToken(session.token)])).rows[0].expires_at as Date;
        const pending = (operation === 'set' ? store.setCompletion(a.user.id, '10', '90', true, authorization(session)) : store.deleteCompletion(a.user.id, '10', '90', authorization(session))).then(() => null, error => error);
        let blocked = false;
        for (let i = 0; i < 20; i++) {
          const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='alms-test-completion' AND wait_event_type='Lock' AND query LIKE '%personal_learning_completions%'");
          if (result.rowCount) { blocked = true; break; } await delay(25);
        }
        assert.equal(blocked, true, operation + ' must reach the completion row lock');
        await delay(Math.max(1, expiry.getTime() - Date.now() + 25)); await locker.query('ROLLBACK');
        const error = await pending; assert.equal(error?.code, 'AUTH_REQUIRED', operation);
        assert.deepEqual(await store.listCompletions(a.user.id, '10'), before, operation + ' must roll back');
      } finally { await locker.query('ROLLBACK'); locker.release(); }
    }
  });

  it('personal completion does not add jobs, school results, or attendance/submission writes', async () => {
    const session = await store.issueVerifiedSession(identity, 3600);
    const schoolBefore = await store.getEncryptedSchoolSession(a.user.id, 'ssu');
    await store.setCompletion(a.user.id, '10', '90', true, authorization(session));
    assert.equal(await store.getEncryptedSchoolSession(a.user.id, 'ssu'), schoolBefore);
    assert.deepEqual(await store.listJobs(a.user.id), []);
    assert.equal((await pool.query('SELECT 1 FROM assignment_operations WHERE user_id=$1', [a.user.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM assignment_uploads WHERE user_id=$1', [a.user.id])).rowCount, 0);
  });

  it('visible assignment publication null/missing permits personal HTTP changes across relogin while explicit false prevents writes', async () => {
    for (const publication of [null, undefined]) {
      let current = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => 'synthetic-generation-before-relogin' });
      const activity: { id: string; courseId: string; type: string; published?: boolean | null; moduleCompleted: boolean } = {
        id: '90', courseId: '10', type: 'assignment', moduleCompleted: true,
        ...(publication === undefined ? {} : { published: publication }),
      };
      let courseReads = 0;
      const app = await buildApp(loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' }), store, {
        ...unavailableSchoolProvider, course: async (context, courseId) => {
          assert.deepEqual(context, { userId: a.user.id }); assert.equal(courseId, '10'); courseReads++;
          return { course: { id: '10' }, weeks: [{ activities: [activity] }] };
        },
      });
      try {
        const saved = await app.inject({ method: 'PATCH', url: path, headers: headers(current), payload: { completed: false } });
        assert.equal(saved.statusCode, 200); assert.equal(saved.json().completed, false); assert.equal(activity.moduleCompleted, true);
        await store.deleteSession(hashToken(current.token));
        assert.equal((await app.inject({ url: '/v1/courses/10/completions', headers: headers(current) })).statusCode, 401);
        const readsBeforeRelogin = courseReads;
        current = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => 'synthetic-generation-after-relogin' });
        assert.equal(current.user.id, a.user.id);
        const restored = await app.inject({ url: '/v1/courses/10/completions', headers: headers(current) });
        assert.equal(restored.statusCode, 200); assert.deepEqual(restored.json().items, [saved.json()]); assert.equal(courseReads, readsBeforeRelogin);
        assert.equal((await app.inject({ method: 'PATCH', url: path, headers: headers(current), payload: { completed: true } })).statusCode, 200);
        assert.equal((await app.inject({ method: 'DELETE', url: path, headers: headers(current) })).statusCode, 204);
        assert.deepEqual(await store.listCompletions(a.user.id, '10'), []);
        await store.setCompletion(a.user.id, '10', '90', false, authorization(current));
        const existing = await store.listCompletions(a.user.id, '10'); activity.published = false;
        for (const method of ['PATCH', 'DELETE'] as const)
          assert.equal((await app.inject({ method, url: path, headers: headers(current), ...(method === 'PATCH' ? { payload: { completed: true } } : {}) })).statusCode, 404);
        assert.deepEqual(await store.listCompletions(a.user.id, '10'), existing);
        assert.equal(activity.moduleCompleted, true); assert.equal((await store.listCompletions(b.user.id, '10'))[0]!.completed, false);
        assert.deepEqual(await store.listJobs(a.user.id), []);
        assert.equal((await pool.query('SELECT 1 FROM assignment_operations WHERE user_id=$1', [a.user.id])).rowCount, 0);
      } finally { await app.close(); }
    }
  });
});
