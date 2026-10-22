import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createMcpReadTools, type McpReadProvider, type McpReadStore } from '../src/mcp-tools/index.js';
import type { McpPrincipal, McpReadToolResult } from '../src/mcp-types.js';
import { AppError } from '../src/errors.js';
import { SchoolError } from '@alms/ssu-api';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { publicCourseContent } from '../src/school-read.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';

const course = { id: '10', title: '합성 강좌', professor: null, term: null, sourceUrl: 'https://example.invalid/private' };
const base = () => ({ capabilities: { schoolAuthentication: true, schoolRead: true, playback: true, pauseResume: false } });
const principal = (patch: Partial<McpPrincipal> = {}): McpPrincipal => ({ userId: 'owner-a', authorizationId: 'private-grant',
  sessionTokenHash: 'private-session-hash', scopes: ['alms:read'], validate: async () => {}, ...patch });
const signal = () => new AbortController().signal;
const store: McpReadStore = { listCompletionsForCourses: async () => [] };
const payload = (result: McpReadToolResult) => result.structuredContent as Record<string, any>;
const outputAjv = new Ajv2020({ strict: false });
(addFormats as unknown as (instance: Ajv2020) => void)(outputAjv);
const outputValidators = new Map(createMcpReadTools({ provider: base(), store }).listToolDefinitions()
  .map(definition => [definition.name, outputAjv.compile(definition.outputSchema!)]));
const call = async (provider: McpReadProvider, name: string, args: unknown, auth = principal()) => {
  const result = await createMcpReadTools({ provider, store }).call(name, args, auth, { signal: signal() });
  const validate = outputValidators.get(name);
  if (validate) assert.equal(validate(result.structuredContent), true, name + ': ' + JSON.stringify(validate.errors));
  return result;
};
function tasks() {
  return { courses: [course], items: [{ id: 'task-1', courseId: '10', courseTitle: '합성 강좌', title: '읽을 자료', type: 'material',
    dueAt: null, sourceUrl: null, schoolStatus: null, progressPercent: null, playbackAvailable: false, todoSource: 'school_todo',
    moduleItemId: '100', weekId: '20', moduleCompleted: false, personalCompleted: null }] };
}
function activity() {
  return { courseId: '10', moduleItemId: '100', title: '합성 자료', descriptionText: '자료 본문', type: 'material', resourceType: 'pdf',
    published: true, opened: true, unlockAt: null, dueAt: null, lateAt: null, lockAt: null, completed: false, attendanceStatus: 'none',
    durationSeconds: null, progressSeconds: null, lastPositionSeconds: null, progressPercent: null, fileName: '읽기.pdf', fileSizeBytes: 10,
    materialViewerUrl: 'https://commons.ssu.ac.kr/em/private-content', materialContentAvailable: true, materialViewAvailable: true,
    manualVideoAvailable: false, manualVideoReportAvailable: false, manualVideoProgressMode: null, observedAt: '2026-10-22T00:00:00Z' };
}
function calendar() {
  return { start: '2026-10-01', end: '2026-10-02', timeZone: 'Asia/Seoul', courses: [{ id: '10', title: '합성 강좌' }], complete: true,
    items: [{ id: 'assignment_90', type: 'assignment', courseId: '10', title: '합성 과제', startsAt: '2026-10-01T01:00:00Z',
      endsAt: '2026-10-01T01:00:00Z', allDay: false, allDayDate: null, dueAt: '2026-10-01T01:00:00Z', assignmentId: '90',
      sourceUrl: 'https://canvas.ssu.ac.kr/courses/10/assignments/90', userSubmitted: true, moduleItemId: '100', weekId: '20',
      moduleCompleted: false, personalCompleted: null }] };
}

test('MCP exposes a fixed read-only tool set and detached definitions', () => {
  const tools = createMcpReadTools({ provider: base(), store });
  const definitions = tools.listToolDefinitions();
  assert.equal(definitions.length, 12);
  assert.equal(definitions.every(item => item.annotations?.readOnlyHint && !item.annotations.destructiveHint), true);
  assert.equal(definitions.some(item => /submit|playback|report|upload|view|reconcile|release/.test(item.name)), false);
  assert.equal(definitions.every(item => item.inputSchema.additionalProperties === false), true);
  definitions[0]!.name = 'changed';
  assert.equal(tools.listToolDefinitions()[0]!.name, 'alms_get_capabilities');
});

test('MCP capabilities preserve school unsupported states and distinguish the MCP no-write policy', async () => {
  const result = payload(await call(base(), 'alms_get_capabilities', {}));
  assert.equal(result.data.schoolFeatures.notices.supported, false);
  assert.equal(result.data.schoolFeatures.notices.reason, 'not_implemented');
  assert.equal(result.data.schoolFeatures.quizzes.reason, 'not_implemented');
  assert.deepEqual(result.data.mcpPolicy, { scope: 'alms:read', schoolWrites: false, materialBytes: false, automaticPlayback: false });
});

test('strict owner, token, URL and unknown tool arguments fail before provider or Store reads', async () => {
  let reads = 0;
  const provider = { ...base(), courses: async () => { reads++; return { items: [], term: null, selectedTermId: null }; } };
  for (const args of [{ userId: 'other' }, { token: 'private' }, { url: 'https://example.invalid' }, { limit: 201 }, { termId: 'bad' }, null]) {
    const result = await call(provider, 'alms_list_courses', args);
    assert.equal(payload(result).error.code, 'MCP_INVALID_ARGUMENTS');
  }
  assert.equal(reads, 0);
  assert.equal(payload(await call(provider, 'alms_upload_file', {})).error.code, 'MCP_INVALID_ARGUMENTS');
  assert.equal(payload(await call(provider, 'alms_list_courses', {}, principal({ scopes: [] }))).error.code, 'MCP_SCOPE_INSUFFICIENT');
  assert.equal(reads, 0);
});

test('provider reads receive only the authenticated owner; extra provider fields and source URLs are removed', async () => {
  const owners: unknown[] = [];
  const result = await call({ ...base(), courses: async (context, options) => {
    owners.push(context, options);
    return { items: [{ ...course, termId: '22', token: 'SECRET', rawHtml: '<iframe src="private">' }], term: null, selectedTermId: '22',
      encryptedSession: 'SECRET', owner: 'other' };
  } }, 'alms_list_courses', { termId: '22' });
  assert.deepEqual(owners, [{ userId: 'owner-a' }, { termId: '22' }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private-grant|private-session|iframe|sourceUrl|encryptedSession/);
  assert.equal(payload(result).data.items[0].id, '10');
  assert.equal(payload(result).meta.complete, null);
});

test('courses and assignments expose explicit output truncation without forging complete source coverage', async () => {
  const courses = await call({ ...base(), courses: async () => ({ items: [course, { ...course, id: '11' }], term: null, selectedTermId: null }) },
    'alms_list_courses', { limit: 1 });
  assert.deepEqual(payload(courses).meta, { source: 'school', schoolRecordWrites: false, textTruncated: false, limit: 1,
    returnedCount: 1, hasMore: true, truncated: true, complete: false });
  const assignments = await call({ ...base(), assignments: async () => assignmentListFixture() }, 'alms_list_assignments', { courseId: '10' });
  assert.equal(payload(assignments).meta.complete, true);
  assert.equal(payload(assignments).meta.hasMore, false);
});

test('course output retains canonical week relations and caps activities without leaking unknown category fields', async () => {
  const content = publicCourseContent({ course, modules: [{ id: '20', week: 1, title: '1주차', items: [] }] });
  (content.categoryScope as unknown as Record<string, unknown>).private = 'SECRET';
  const result = await call({ ...base(), course: async () => content }, 'alms_get_course', { courseId: '10', weekId: '20' });
  assert.equal(payload(result).data.weeks[0].id, '20');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|sourceUrl/);
  assert.equal(payload(await call({ ...base(), course: async () => content }, 'alms_get_course', { courseId: '10', weekId: '99' })).error.code, 'NOT_FOUND');
});

test('activity metadata never returns media/viewer/write controls or invokes school learning write methods', async () => {
  let reads = 0, writes = 0;
  const provider = { ...base(), activity: async () => { reads++; return { ...activity(), iframeUrl: 'SECRET', sToken: 'SECRET', rawHtml: 'SECRET' }; },
    recordMaterialView: async () => { writes++; }, video: async () => { writes++; }, authorizePlayback: async () => { writes++; },
    submit: async () => { writes++; } } as unknown as McpReadProvider;
  const result = await call(provider, 'alms_get_activity', { courseId: '10', activityId: '100' });
  assert.equal(result.isError, undefined); assert.equal(reads, 1); assert.equal(writes, 0);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|materialViewer|manualVideo|materialViewAvailable|materialContentAvailable/);
});

test('cross-target activity and assignment responses fail closed', async () => {
  const badActivity = await call({ ...base(), activity: async () => ({ ...activity(), courseId: '11' }) }, 'alms_get_activity', { courseId: '10', activityId: '100' });
  assert.equal(payload(badActivity).error.code, 'MCP_SOURCE_INVALID');
  const badAssignment = await call({ ...base(), assignment: async () => ({ ...assignmentFixture(), id: '91' }) }, 'alms_get_assignment', { courseId: '10', assignmentId: '90' });
  assert.equal(payload(badAssignment).error.code, 'MCP_SOURCE_INVALID');
});

test('assignment instructions truncate text explicitly and retain school submission/grade state', async () => {
  const result = await call({ ...base(), assignment: async () => ({ ...assignmentFixture(), descriptionText: '가'.repeat(200),
    ownSubmittedContent: { text: '내 제출 본문', url: 'https://example.invalid/private' } }) }, 'alms_get_assignment', { courseId: '10', assignmentId: '90', maxTextChars: 100 });
  assert.equal(payload(result).data.descriptionText.length, 100);
  assert.equal(payload(result).meta.textTruncated, true);
  assert.equal(payload(result).data.submission.workflowState, 'submitted');
  assert.equal(payload(result).data.submission.attempt, 1);
  assert.equal(payload(result).data.submission.resultVisibility, 'not_posted');
  assert.equal(payload(result).data.ownSubmittedContent.url, undefined);
});

test('planning reads merge personal overrides and finally validate the exact original DTO without later async authority reads', async () => {
  for (const kind of ['tasks', 'calendar'] as const) {
    const original = kind === 'tasks' ? tasks() : calendar(), order: string[] = [];
    const auth = principal({ validate: async () => { order.push('principal'); } });
    const provider = { ...base(),
      [kind]: async (context: { userId: string }) => { assert.deepEqual(context, { userId: 'owner-a' }); order.push('read'); return original; },
      [kind === 'tasks' ? 'validateTasks' : 'validateCalendar']: async (context: { userId: string; sessionTokenHash: string }, value: unknown) => {
        order.push('proof'); assert.equal(value, original); assert.deepEqual(context, { userId: 'owner-a', sessionTokenHash: 'private-session-hash' });
      },
    } as McpReadProvider;
    const tools = createMcpReadTools({ provider, store: { listCompletionsForCourses: async (owner, courses) => {
      assert.equal(owner, 'owner-a'); assert.deepEqual(courses, ['10']); order.push('override');
      return [{ courseId: '10', activityId: '100', completed: true, updatedAt: '2026-10-22T00:00:00Z' }];
    } } });
    const args = kind === 'tasks' ? {} : { start: '2026-10-01', end: '2026-10-02' };
    const result = await tools.call(kind === 'tasks' ? 'alms_list_tasks' : 'alms_get_calendar', args, auth, { signal: signal() });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(order, ['principal', 'read', 'override', 'principal', 'proof']);
    assert.equal(payload(result).data.items[0].personalCompleted, true);
    assert.equal(payload(result).data.items[0].moduleCompleted, false);
    if (kind === 'calendar') assert.equal(payload(result).data.items[0].userSubmitted, true);
    assert.doesNotMatch(JSON.stringify(result), /private-session-hash|sourceUrl/);
  }
});

test('planning proof rejection or grant revocation never returns school content', async () => {
  const original = tasks();
  for (const revoke of [false, true]) {
    let checks = 0;
    const auth = principal({ validate: async () => { if (++checks > 1 && revoke) throw new AppError(401, 'MCP_AUTH_REQUIRED', 'SECRET'); } });
    const provider = { ...base(), tasks: async () => original,
      validateTasks: async () => { throw new AppError(409, 'SCHOOL_SESSION_CHANGED', 'SECRET'); } };
    const result = await call(provider, 'alms_list_tasks', {}, auth);
    assert.equal(result.isError, true);
    assert.equal(payload(result).error.code, revoke ? 'MCP_AUTH_REQUIRED' : 'SCHOOL_SESSION_CHANGED');
    assert.doesNotMatch(JSON.stringify(result), /읽을 자료|SECRET/);
  }
});

test('unavailable planning validators and unauthorized override rows fail closed', async () => {
  assert.equal(payload(await call({ ...base(), tasks: async () => tasks() }, 'alms_list_tasks', {})).error.code, 'MCP_FEATURE_UNAVAILABLE');
  let proof = 0;
  const tools = createMcpReadTools({ provider: { ...base(), tasks: async () => tasks(), validateTasks: async () => { proof++; } },
    store: { listCompletionsForCourses: async () => [{ courseId: '99', activityId: '100', completed: true, updatedAt: '2026-10-22T00:00:00Z' }] } });
  const result = await tools.call('alms_list_tasks', {}, principal(), { signal: signal() });
  assert.equal(payload(result).error.code, 'MCP_SOURCE_INVALID'); assert.equal(proof, 0);
});

test('school authentication errors are tool errors rather than MCP OAuth errors and never include upstream text', async () => {
  const result = await call({ ...base(), courses: async () => { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'SECRET'); } }, 'alms_list_courses', {});
  assert.equal(result.isError, true);
  assert.deepEqual(payload(result).error, { code: 'SCHOOL_AUTH_REQUIRED', message: '학교 인증을 갱신해 주세요.', schoolReauthenticationRequired: true });
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('malformed unknown DTOs and excessive response bytes fail safely', async () => {
  assert.equal(payload(await call({ ...base(), courses: async () => ({ items: [{ id: '10' }] }) }, 'alms_list_courses', {})).error.code, 'MCP_SOURCE_INVALID');
  const large = await call({ ...base(), courses: async () => ({ items: Array.from({ length: 100 }, (_, n) => ({ ...course, id: String(n + 1), title: '가'.repeat(1000) })),
    term: null, selectedTermId: null }) }, 'alms_list_courses', { limit: 100 });
  assert.equal(payload(large).error.code, 'MCP_RESPONSE_TOO_LARGE');
  assert.equal(JSON.stringify(large).length < 1000, true);
});

test('calendar rejects invalid or excessive ranges before reading the school', async () => {
  let calls = 0;
  const provider = { ...base(), calendar: async () => { calls++; return calendar() as any; }, validateCalendar: async () => {} };
  for (const args of [{ start: '2026-10-01', end: '2026-12-01' }, { start: '2026-02-30', end: '2026-03-02' }, { start: '2026-10-02', end: '2026-10-01' }])
    assert.equal(payload(await call(provider, 'alms_get_calendar', args)).error.code, 'MCP_INVALID_ARGUMENTS');
  assert.equal(calls, 0);
});

test('cancelled non-abortable reads keep their concurrency slot until actual settlement and return no data', async () => {
  let release!: (value: unknown) => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let blocked = true;
  const provider = { ...base(), courses: async () => { if (blocked) { began(); return new Promise(resolve => { release = resolve; }); }
    return { items: [], term: null, selectedTermId: null }; } };
  const tools = createMcpReadTools({ provider, store }), controller = new AbortController();
  const pending = tools.call('alms_list_courses', {}, principal(), { signal: controller.signal });
  await started; controller.abort();
  const cancelled = await pending;
  assert.equal(payload(cancelled).error.code, 'MCP_CANCELLED');
  assert.equal(payload(await tools.call('alms_list_courses', {}, principal(), { signal: signal() })).error.code, 'MCP_BUSY');
  blocked = false; release({ items: [course], term: null, selectedTermId: null }); await tick();
  assert.equal((await tools.call('alms_list_courses', {}, principal(), { signal: signal() })).isError, undefined);
});

test('learning status preserves unknown recognition and evidence without playback or progress reporting', async () => {
  const result = await call({ ...base(), learningStatus: async (context, target) => {
    assert.deepEqual(context, { userId: 'owner-a' }); assert.deepEqual(target, { courseId: '10', lectureId: '100' });
    return { observedAt: '2026-10-22T00:00:00Z', progressPercent: 100, attendance: 'unknown', recognized: null };
  } }, 'alms_get_learning_status', { courseId: '10', activityId: '100' });
  assert.equal(payload(result).data.schoolResult.recognized, null);
  assert.equal(payload(result).data.schoolResult.attendance, 'unknown');
});

test('requested term must match every returned course and the selected source term', async () => {
  for (const value of [{ items: [course], term: null, selectedTermId: '22' },
    { items: [{ ...course, termId: '22' }], term: null, selectedTermId: '23' }]) {
    assert.equal(payload(await call({ ...base(), courses: async () => value }, 'alms_list_courses', { termId: '22' })).error.code, 'MCP_SOURCE_INVALID');
  }
});

test('terms, timetable and attendance use the existing owner-scoped methods with bounded sanitized outputs', async () => {
  const contexts: unknown[] = [];
  const provider = { ...base(), courseTerms: async (context: unknown) => {
    contexts.push(context); return { items: [{ id: '22', label: '2026년 2학기', year: 2026, current: true }], defaultTermId: '22' };
  }, timetable: async (context: unknown) => {
    contexts.push(context); return { term: null, items: [{ id: 'schedule-1', courseId: '10', courseTitle: '합성 강좌', dayOfWeek: 1,
      startTime: '09:00', endTime: '10:50', room: null, professor: null, secret: 'SECRET' }] };
  }, attendance: async (context: unknown, courseId?: string) => {
    contexts.push(context, courseId); return { items: [{ id: 'attendance-1', courseId: '10', courseTitle: '합성 강좌', title: '1차시', week: 1,
      date: null, type: '차시 출결', progressPercent: null, schoolStatus: '확인 안 됨', schoolStatusCode: null,
      checkedAt: '2026-10-22T00:00:00Z', sourceUrl: null }] };
  } };
  for (const [name, args] of [['alms_list_terms', {}], ['alms_get_timetable', {}], ['alms_get_attendance', { courseId: '10' }]] as const) {
    const result = await call(provider, name, args); assert.equal(result.isError, undefined); assert.doesNotMatch(JSON.stringify(result), /SECRET|sourceUrl/);
  }
  assert.deepEqual(contexts, [{ userId: 'owner-a' }, { userId: 'owner-a' }, { userId: 'owner-a' }, '10']);
});

test('source unsupported, forbidden and malformed errors remain distinct safe tool failures', async () => {
  for (const [schoolCode, expected] of [['unsupported', 'MCP_RESOURCE_UNSUPPORTED'], ['forbidden_target', 'NOT_FOUND'], ['unexpected_response', 'MCP_SOURCE_INVALID']] as const) {
    const result = await call({ ...base(), courses: async () => { throw new SchoolError(schoolCode); } }, 'alms_list_courses', {});
    assert.equal(payload(result).error.code, expected); assert.equal(result.isError, true);
  }
});

test('revocation after an ordinary school read suppresses its otherwise valid content', async () => {
  let valid = true;
  const auth = principal({ validate: async () => { if (!valid) throw new AppError(401, 'MCP_AUTH_REQUIRED', 'SECRET'); } });
  const result = await call({ ...base(), courses: async () => { valid = false; return { items: [course], term: null, selectedTermId: null }; } },
    'alms_list_courses', {}, auth);
  assert.equal(payload(result).error.code, 'MCP_AUTH_REQUIRED'); assert.doesNotMatch(JSON.stringify(result), /합성 강좌|SECRET/);
});

test('pre-cancelled requests do not reach the owner validator or provider', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const tools = createMcpReadTools({ provider: { ...base(), courses: async () => { calls++; return {}; } }, store });
  const result = await tools.call('alms_list_courses', {}, principal({ validate: async () => { calls++; } }), { signal: controller.signal });
  assert.equal(payload(result).error.code, 'MCP_CANCELLED'); assert.equal(calls, 0);
});
