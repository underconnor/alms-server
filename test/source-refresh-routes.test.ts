import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider, type SchoolProvider, type SourceReadOptions } from '../src/provider.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';
import { createLearningxReads, type LearningxReader } from '../src/school-read.js';

const cookie = '__Host-alms_session=' + 'a'.repeat(43);
async function fixture() {
  let active = true;
  const calls: Array<{ resource: string; owner: string; options?: SourceReadOptions & { signal?: AbortSignal; validate?: () => Promise<void> } }> = [];
  const session = { user: { id: 'owner-a' }, tokenHash: 'synthetic-session' };
  const store = { getSession: async () => active ? session : null, listCompletionsForCourses: async () => [] } as unknown as Store;
  const provider: SchoolProvider = { ...unavailableSchoolProvider,
    course: async (context, _id, options) => { calls.push({ resource: 'course', owner: context.userId, options }); return { weeks: [] }; },
    tasks: async (context, options) => { calls.push({ resource: 'tasks', owner: context.userId, options }); return { items: [] }; },
    assignments: async (context, _id, options) => { calls.push({ resource: 'assignments', owner: context.userId, options }); return assignmentListFixture(); },
    assignment: async (context, _id, _assignment, options) => { calls.push({ resource: 'assignment', owner: context.userId, options }); return assignmentFixture(); },
    calendar: async (context, query, options) => { calls.push({ resource: 'calendar', owner: context.userId, options }); return { ...query, courses: [], items: [], complete: true, timeZone: 'Asia/Seoul' }; },
  };
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, provider);
  return { app, calls, provider, revoke: () => { active = false; } };
}
const resources = [
  ['/v1/courses/10', 'course'], ['/v1/tasks', 'tasks'], ['/v1/courses/10/assignments', 'assignments'],
  ['/v1/courses/10/assignments/90', 'assignment'], ['/v1/calendar?start=2026-11-01&end=2026-11-30', 'calendar'],
] as const;
for (const mode of ['1', 'resource'] as const) test(`explicit ${mode} revalidation reaches each supported provider with bounded caller checks`, async () => {
  const f = await fixture();
  try {
    for (const [path, resource] of resources) {
      const response = await f.app.inject({ url: path + (path.includes('?') ? '&' : '?') + 'refresh=' + mode, headers: { cookie } });
      assert.equal(response.statusCode, 200, resource + ': ' + response.body);
      const call = f.calls.at(-1)!;
      assert.equal(call.resource, resource); assert.equal(call.owner, 'owner-a');
      assert.equal(call.options?.refresh, true);
      assert.equal(call.options?.refreshScope, mode === 'resource' ? 'resource' : undefined);
      assert.ok(call.options?.signal instanceof AbortSignal); assert.equal(typeof call.options?.validate, 'function');
      await call.options!.validate!();
    }
  } finally { await f.app.close(); }
});
test('default reads preserve their existing mode and explicit refresh is authenticated before dispatch', async () => {
  const f = await fixture();
  try {
    for (const [path] of resources) {
      assert.equal((await f.app.inject({ url: path, headers: { cookie } })).statusCode, 200);
      assert.equal(f.calls.at(-1)!.options?.refresh, undefined);
      assert.equal(f.calls.at(-1)!.options?.refreshScope, undefined);
    }
    const count = f.calls.length;
    for (const [path] of resources)
      assert.equal((await f.app.inject(path + (path.includes('?') ? '&' : '?') + 'refresh=resource')).statusCode, 401);
    assert.equal(f.calls.length, count);
  } finally { await f.app.close(); }
});
test('fresh read queries reject duplicate modes, foreign authority and unknown values before school dispatch', async () => {
  const f = await fixture();
  try {
    for (const [path] of resources) for (const query of ['refresh=0', 'refresh=resource&refresh=1', 'refresh=resource&userId=owner-b', 'refresh=resource&generation=other']) {
      const response = await f.app.inject({ url: path + (path.includes('?') ? '&' : '?') + query, headers: { cookie } });
      assert.equal(response.statusCode, 400, path + ': ' + query);
    }
    assert.equal(f.calls.length, 0);
    // Lazy history/file reads intentionally keep the established full refresh contract.
    for (const path of ['/v1/courses/10/assignments/90/submission-history', '/v1/courses/10/assignments/90/files/7'])
      assert.equal((await f.app.inject({ url: path + '?refresh=resource', headers: { cookie } })).statusCode, 400);
  } finally { await f.app.close(); }
});
test('logout during a fresh course read cannot publish the returned school payload', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.provider.course = async (_context, _id, options) => { await options!.validate!(); entered(); await held; return { weeks: ['private-old-response'] }; };
  try {
    const pending = f.app.inject({ url: '/v1/courses/10?refresh=resource', headers: { cookie } });
    await started; f.revoke(); release(); const response = await pending;
    assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'AUTH_REQUIRED');
    assert.equal(response.body.includes('private-old-response'), false);
  } finally { release(); await f.app.close(); }
});
test('course adapter passes the exact source-read options to the reader without public proof fields', async () => {
  const options = { refresh: true, refreshScope: 'resource' as const, signal: new AbortController().signal, validate: async () => {} };
  const reader = { readCourse: async (owner: string, id: string, received: unknown) => {
    assert.equal(owner, 'owner-a'); assert.equal(id, '10'); assert.equal(received, options);
    return { course: { id: '10', title: 'Synthetic course', professor: null, term: null, sourceUrl: null }, modules: [], observedAt: '2026-11-04T00:00:00Z' };
  } } as unknown as LearningxReader;
  const result = await createLearningxReads(reader).course!({ userId: 'owner-a' }, '10', options);
  assert.equal(JSON.stringify(result).includes('refreshScope'), false);
});
