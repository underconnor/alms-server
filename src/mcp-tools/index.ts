import { z } from 'zod';
import { SchoolError } from '@alms/ssu-api';
import type { SchoolProvider } from '../provider.js';
import type { Store } from '../store.js';
import type { McpPrincipal, McpReadTools, McpReadToolDefinition, McpReadToolResult } from '../mcp-types.js';
import { AppError } from '../errors.js';
import { providerFeatures } from '../feature-support.js';
import { calendarQuery } from '../calendar.js';
import { publicVerifiedSchoolResult } from '../job-verification.js';
import { checked, equalTarget, features, object, project, rows, type Projection } from './validation.js';
import { mcpOutputSchema } from './output-schema.js';

export type McpReadProvider = Pick<SchoolProvider, 'capabilities' | 'courseTerms' | 'courses' | 'course' | 'activity'
  | 'assignments' | 'assignment' | 'tasks' | 'validateTasks' | 'calendar' | 'validateCalendar' | 'timetable' | 'attendance' | 'learningStatus'>;
export type McpReadStore = Pick<Store, 'listCompletionsForCourses'>;
const id = z.string().regex(/^[1-9]\d{0,15}$/);
const limit = z.number().int().min(1).max(200).default(50);
const maxTextChars = z.number().int().min(100).max(30_000).default(10_000);
const schemas = {
  alms_get_capabilities: z.object({}).strict(),
  alms_list_terms: z.object({ limit }).strict(),
  alms_list_courses: z.object({ termId: id.optional(), limit }).strict(),
  alms_get_course: z.object({ courseId: id, weekId: id.optional(), limit }).strict(),
  alms_get_activity: z.object({ courseId: id, activityId: id, maxTextChars }).strict(),
  alms_list_assignments: z.object({ courseId: id, limit }).strict(),
  alms_get_assignment: z.object({ courseId: id, assignmentId: id, maxTextChars }).strict(),
  alms_list_tasks: z.object({ courseId: id.optional(), limit }).strict(),
  alms_get_calendar: z.object({ start: z.string(), end: z.string(), courseId: id.optional(), limit }).strict(),
  alms_get_timetable: z.object({ limit }).strict(),
  alms_get_attendance: z.object({ courseId: id.optional(), limit }).strict(),
  alms_get_learning_status: z.object({ courseId: id, activityId: id }).strict(),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  alms_get_capabilities: 'Read supported school features and the separate read-only MCP policy. Target permissions still require a selected school read.',
  alms_list_terms: 'Read this user’s school-returned academic terms. Default terms are not an assertion of the calendar-current term.',
  alms_list_courses: 'Read owned courses, optionally in a school-returned term. No enrollment or school login is started.',
  alms_get_course: 'Read owned weeks and activity metadata. Optional weekId narrows output; limit caps activities across all returned weeks.',
  alms_get_activity: 'Read one activity’s plain text and school metadata. No media, viewer URL, playback, progress report or read receipt.',
  alms_list_assignments: 'Read the full school assignment collection, bounded for this response. Submission and learning completion remain separate.',
  alms_get_assignment: 'Read one assignment’s instructions and current school submission, grading and attachment metadata. Never submit or reconcile.',
  alms_list_tasks: 'Read school pending activities and owner personal completion overrides. Absence from this feed is not submission proof.',
  alms_get_calendar: 'Read school events and own submission flags in a Seoul [start,end) date range of at most31days.',
  alms_get_timetable: 'Read the owner’s school timetable and verified course links. No inferred cross-course identifiers.',
  alms_get_attendance: 'Read school lesson attendance. Keep lesson status separate from individual video progress and recognized values.',
  alms_get_learning_status: 'Fresh read of one activity’s school progress and evidence. Does not play, report, or change learning completion.',
};
const MAX_RESPONSE_BYTES = 96 * 1024, MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const unavailable = () => new AppError(503, 'MCP_FEATURE_UNAVAILABLE', '이 조회 기능은 아직 제공하지 않습니다.');
const invalid = () => new AppError(502, 'MCP_SOURCE_INVALID', '학교 응답 형식을 확인하지 못했습니다.');
function abortError(signal: AbortSignal) {
  return new AppError(503, signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'MCP_TIMEOUT' : 'MCP_CANCELLED', '조회가 중단됐습니다.');
}
function live(signal: AbortSignal) { if (signal.aborted) throw abortError(signal); }
function wait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    if (signal.aborted) { void pending.catch(() => {}); reject(abortError(signal)); return; }
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function safeSource(name: string, value: unknown) {
  try { if (Buffer.byteLength(JSON.stringify(value)) > MAX_SOURCE_BYTES) throw invalid(); }
  catch { throw invalid(); }
  return checked(name, value);
}
function response(payload: Record<string, unknown>, isError = false): McpReadToolResult {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new AppError(413, 'MCP_RESPONSE_TOO_LARGE', '응답이 큽니다. 강좌·주차·기간 또는 limit을 줄여 조회해 주세요.');
  return { content: [{ type: 'text', text }], structuredContent: payload, ...(isError ? { isError: true } : {}) };
}
function toolError(error: unknown): McpReadToolResult {
  let code = 'MCP_READ_FAILED', message = '학교 정보를 불러오지 못했습니다.';
  if (error instanceof z.ZodError) { code = 'MCP_INVALID_ARGUMENTS'; message = '조회 인수를 확인해 주세요.'; }
  else if (error instanceof AppError) {
    // Explicit allowlist: arbitrary provider messages and codes may contain private values.
    const messages: Record<string, string> = {
      AUTH_REQUIRED: 'ALMS 인증을 다시 확인해 주세요.', MCP_AUTH_REQUIRED: 'MCP 인증을 다시 확인해 주세요.',
      MCP_SCOPE_INSUFFICIENT: '조회 권한이 필요합니다.', SCHOOL_AUTH_REQUIRED: '학교 인증을 갱신해 주세요.',
      SCHOOL_AUTH_FAILED: '학교 인증을 갱신해 주세요.', SCHOOL_SESSION_CHANGED: '학교 인증이 변경됐습니다. 다시 조회해 주세요.',
      SCHOOL_UPSTREAM_UNAVAILABLE: '학교 응답이 지연되고 있습니다.', MCP_INVALID_ARGUMENTS: '조회 인수를 확인해 주세요.',
      MCP_SOURCE_INVALID: '학교 응답 형식을 확인하지 못했습니다.', MCP_RESPONSE_TOO_LARGE: '응답이 큽니다. 강좌·주차·기간 또는 limit을 줄여 조회해 주세요.',
      MCP_FEATURE_UNAVAILABLE: '이 조회 기능은 아직 제공하지 않습니다.', MCP_CANCELLED: '조회가 취소됐습니다.',
      SCHOOL_PROVIDER_UNAVAILABLE: '이 학교 정보는 아직 조회할 수 없습니다.', MCP_RESOURCE_UNSUPPORTED: '이 자료 형식은 아직 지원하지 않습니다.',
      MCP_TIMEOUT: '조회 시간이 초과됐습니다.', MCP_BUSY: '이전 조회가 진행 중입니다. 잠시 후 다시 시도해 주세요.',
      RATE_LIMITED: '잠시 후 다시 시도해 주세요.', NOT_FOUND: '선택한 학교 항목을 찾지 못했습니다.',
    };
    if (Object.hasOwn(messages, error.code)) { code = error.code; message = messages[code]!; }
  } else if (error instanceof SchoolError) {
    const normalized = {
      authentication_required: ['SCHOOL_AUTH_REQUIRED', '학교 인증을 갱신해 주세요.'],
      identity_mismatch: ['SCHOOL_AUTH_REQUIRED', '학교 인증을 갱신해 주세요.'],
      unsupported: ['MCP_RESOURCE_UNSUPPORTED', '이 자료 형식은 아직 지원하지 않습니다.'],
      forbidden_target: ['NOT_FOUND', '선택한 학교 항목을 찾지 못했습니다.'],
      upstream_unavailable: ['SCHOOL_UPSTREAM_UNAVAILABLE', '학교 응답이 지연되고 있습니다.'],
      unexpected_response: ['MCP_SOURCE_INVALID', '학교 응답 형식을 확인하지 못했습니다.'],
    }[error.code];
    code = normalized[0]!; message = normalized[1]!;
  }
  return response({ error: { code, message, schoolReauthenticationRequired: ['SCHOOL_AUTH_REQUIRED', 'SCHOOL_AUTH_FAILED'].includes(code) } }, true);
}

/** Read-only adapter. No school HTTP client, bytes, playback or submission method is available here. */
export function createMcpReadTools({ provider, store }: { provider: McpReadProvider; store: McpReadStore }): McpReadTools {
  const active = new Set<string>();
  const definitions: McpReadToolDefinition[] = (Object.keys(schemas) as ToolName[]).map(name => ({ name,
    description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name], { target: 'draft-7', io: 'input' }), outputSchema: mcpOutputSchema(name),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));
  return {
    listToolDefinitions: () => structuredClone(definitions),
    async call(name, args, principal: McpPrincipal, options) {
      try {
        if (!Object.hasOwn(schemas, name)) throw new AppError(400, 'MCP_INVALID_ARGUMENTS', 'Unknown tool');
        if (!principal.scopes.includes('alms:read')) throw new AppError(403, 'MCP_SCOPE_INSUFFICIENT', 'Read scope required');
        const parsed = schemas[name as ToolName].parse(args === undefined ? {} : args) as Record<string, unknown>;
        // Do not accept owner/session/token/URL arguments, including additional fields.
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
        live(signal);
        await wait(principal.validate(signal), signal);
        live(signal);
        if (active.has(principal.userId) || active.size >= 100) throw new AppError(409, 'MCP_BUSY', 'Busy');
        active.add(principal.userId);
        const run = async () => {
          const context = { userId: principal.userId };
          const validate = async () => { live(signal); await wait(principal.validate(signal), signal); live(signal); };
          const projection: Projection = { textTruncated: false, textLimit: Number(parsed.maxTextChars ?? 10_000) };
          const meta: Record<string, unknown> = { source: 'school', schoolRecordWrites: false, textTruncated: false };
          let data: unknown, finalProof = false;
          const take = <T>(items: readonly T[], sourceComplete?: unknown): T[] => {
            const cap = Number(parsed.limit ?? 50), hasMore = items.length > cap;
            Object.assign(meta, { limit: cap, returnedCount: Math.min(items.length, cap), hasMore, truncated: hasMore,
              complete: hasMore ? false : sourceComplete === true ? true : null });
            return items.slice(0, cap);
          };
          const read = async <T>(run: () => Promise<T>): Promise<T> => { live(signal); const result = await run(); live(signal); return result; };
          const ownerCompletions = async (courses: readonly string[]) => {
            if (courses.length > 100 || courses.some(course => !id.safeParse(course).success)) throw invalid();
            const records = await read(() => store.listCompletionsForCourses(principal.userId, courses));
            if (records.some(row => !courses.includes(row.courseId))) throw invalid();
            return records;
          };
          const completionCourses = async (courses: readonly string[]) => [...new Set((await ownerCompletions(courses)).map(row => row.courseId))];
          switch (name as ToolName) {
            case 'alms_get_capabilities': {
              data = { schoolFeatures: features(providerFeatures(provider, { assignmentSubmission: false, manualVideo: false, playbackStart: false, playbackReady: false })),
                mcpPolicy: { scope: 'alms:read', schoolWrites: false, materialBytes: false, automaticPlayback: false } };
              meta.source = 'ALMS'; break;
            }
            case 'alms_list_terms': {
              if (!provider.courseTerms) throw unavailable();
              const raw = safeSource('CourseTerms', await read(() => provider.courseTerms!(context)));
              data = { ...object(project('CourseTerms', raw, projection)), items: take(rows(raw.items)).map(item => project('CourseTerm', item, projection)) }; break;
            }
            case 'alms_list_courses': {
              if (!provider.courses) throw unavailable();
              const raw = safeSource('CourseList', await read(() => provider.courses!(context, parsed.termId ? { termId: String(parsed.termId) } : {})));
              if (parsed.termId && (raw.selectedTermId !== parsed.termId || rows(raw.items).some(item => item.termId !== parsed.termId))) throw invalid();
              data = { ...object(project('CourseList', raw, projection)), items: take(rows(raw.items)).map(item => project('Course', item, projection)) }; break;
            }
            case 'alms_get_course': {
              if (!provider.course) throw unavailable();
              const raw = safeSource('CourseContent', await read(() => provider.course!(context, String(parsed.courseId))));
              equalTarget(raw.course, String(parsed.courseId), 'id');
              const all = rows(raw.weeks); let left = Number(parsed.limit), total = 0;
              for (const week of all) for (const activity of rows(week.activities)) equalTarget(activity, String(parsed.courseId));
              const selected = parsed.weekId ? all.filter(week => week.id === parsed.weekId) : all;
              if (parsed.weekId && selected.length !== 1) throw new AppError(404, 'NOT_FOUND', 'Missing week');
              const weeks = selected.map(week => {
                const items = rows(week.activities); total += items.length;
                const kept = items.slice(0, Math.max(0, left)); left -= kept.length;
                return { ...object(project('Week', week, projection)), activities: kept.map(item => project('Activity', item, projection)) };
              });
              Object.assign(meta, { limit: Number(parsed.limit), returnedCount: Math.min(total, Number(parsed.limit)), truncated: total > Number(parsed.limit),
                hasMore: total > Number(parsed.limit), complete: total > Number(parsed.limit) ? false : null });
              data = { course: project('Course', raw.course, projection), weeks, currentWeek: project('CurrentWeek', raw.currentWeek, projection),
                categoryScope: { materials: 'modules', assignments: 'modules' }, ...(raw.featureSupport ? { featureSupport: features(raw.featureSupport) } : {}) }; break;
            }
            case 'alms_get_activity': {
              if (!provider.activity) throw unavailable();
              const raw = safeSource('ActivityDetail', await read(() => provider.activity!(context, String(parsed.courseId), String(parsed.activityId))));
              equalTarget(raw, String(parsed.courseId)); equalTarget(raw, String(parsed.activityId), 'moduleItemId');
              data = project('ActivityDetail', raw, projection); break;
            }
            case 'alms_list_assignments': {
              if (!provider.assignments) throw unavailable();
              const raw = safeSource('Assignments', await read(() => provider.assignments!(context, String(parsed.courseId), { signal, validate })));
              equalTarget(raw, String(parsed.courseId)); for (const item of rows(raw.items)) equalTarget(item, String(parsed.courseId));
              data = { courseId: raw.courseId, ...(raw.course ? { course: project('AssignmentCourseContext', raw.course, projection) } : {}),
                items: take(rows(raw.items), raw.complete).map(item => project('Assignment', item, projection)),
                ...(raw.featureSupport ? { featureSupport: features(raw.featureSupport) } : {}) }; break;
            }
            case 'alms_get_assignment': {
              if (!provider.assignment) throw unavailable();
              const raw = safeSource('AssignmentDetail', await read(() => provider.assignment!(context, String(parsed.courseId), String(parsed.assignmentId), { signal, validate })));
              equalTarget(raw, String(parsed.courseId)); equalTarget(raw, String(parsed.assignmentId), 'id');
              if (raw.course) equalTarget(raw.course, String(parsed.courseId), 'id');
              data = project('AssignmentDetail', raw, projection); break;
            }
            case 'alms_list_tasks': {
              if (!provider.tasks || !provider.validateTasks) throw unavailable();
              const original = await read(() => provider.tasks!(context, { signal, validate, personalCompletionCourses: completionCourses }));
              const raw = safeSource('Tasks', original), all = rows(raw.items);
              const courses = rows(raw.courses).map(course => String(course.id));
              if (parsed.courseId && !courses.includes(String(parsed.courseId))) throw new AppError(404, 'NOT_FOUND', 'Missing course');
              if (all.some(item => !courses.includes(String(item.courseId)))) throw invalid();
              const linked = [...new Set(all.filter(item => item.moduleItemId).map(item => String(item.courseId)))];
              const completions = await ownerCompletions(linked);
              const overrides = new Map(completions.map(row => [JSON.stringify([row.courseId, row.activityId]), row.completed]));
              await validate();
              await read(() => provider.validateTasks!({ ...context, sessionTokenHash: principal.sessionTokenHash }, original));
              finalProof = true;
              const selected = parsed.courseId ? all.filter(item => item.courseId === parsed.courseId) : all;
              data = { items: take(selected).map(item => ({ ...object(project('SchoolTask', item, projection)), ...(item.moduleItemId
                ? { personalCompleted: overrides.get(JSON.stringify([item.courseId, item.moduleItemId])) ?? null } : {}) })),
                courses: rows(raw.courses).filter(course => !parsed.courseId || course.id === parsed.courseId).map(course => project('Course', course, projection)) }; break;
            }
            case 'alms_get_calendar': {
              if (!provider.calendar || !provider.validateCalendar) throw unavailable();
              const query = calendarQuery.parse({ start: parsed.start, end: parsed.end, ...(parsed.courseId ? { courseId: parsed.courseId } : {}) });
              const original = await read(() => provider.calendar!(context, query, { signal, validate, personalCompletionCourses: completionCourses }));
              const raw = safeSource('Calendar', original), all = rows(raw.items);
              if (raw.start !== query.start || raw.end !== query.end || parsed.courseId && all.some(item => item.courseId !== parsed.courseId)) throw invalid();
              const courses = rows(raw.courses).map(course => String(course.id));
              if (all.some(item => !courses.includes(String(item.courseId)))) throw invalid();
              const linked = [...new Set(all.filter(item => item.type === 'assignment' && item.moduleItemId).map(item => String(item.courseId)))];
              const completions = await ownerCompletions(linked);
              const overrides = new Map(completions.map(row => [JSON.stringify([row.courseId, row.activityId]), row.completed]));
              await validate();
              await read(() => provider.validateCalendar!({ ...context, sessionTokenHash: principal.sessionTokenHash }, original));
              finalProof = true;
              data = { start: raw.start, end: raw.end, timeZone: raw.timeZone,
                courses: rows(raw.courses).map(course => ({ id: course.id, title: course.title })),
                items: take(all, raw.complete).map(item => ({ ...object(project('CalendarItem', item, projection)), ...(item.type === 'assignment' && item.moduleItemId
                  ? { personalCompleted: overrides.get(JSON.stringify([item.courseId, item.moduleItemId])) ?? null } : {}) })) }; break;
            }
            case 'alms_get_timetable': {
              if (!provider.timetable) throw unavailable();
              const raw = safeSource('Timetable', await read(() => provider.timetable!(context)));
              data = { term: raw.term, items: take(rows(raw.items)).map(item => project('Schedule', item, projection)) }; break;
            }
            case 'alms_get_attendance': {
              if (!provider.attendance) throw unavailable();
              const raw = safeSource('Attendance', await read(() => provider.attendance!(context, parsed.courseId ? String(parsed.courseId) : undefined)));
              if (parsed.courseId) for (const item of rows(raw.items)) equalTarget(item, String(parsed.courseId));
              data = { items: take(rows(raw.items)).map(item => project('AttendanceItem', item, projection)) }; break;
            }
            case 'alms_get_learning_status': {
              if (!provider.learningStatus) throw unavailable();
              const raw = await read(() => provider.learningStatus!(context, { courseId: String(parsed.courseId), lectureId: String(parsed.activityId) }, signal));
              const value = publicVerifiedSchoolResult(raw);
              data = { courseId: parsed.courseId, activityId: parsed.activityId, schoolResult: project('SchoolResult', value, projection) }; break;
            }
          }
          // No async authority lookup follows the exact original planning proof snapshot.
          if (!finalProof) await validate();
          live(signal);
          meta.textTruncated = projection.textTruncated;
          return response({ data, meta });
        };
        // A timed-out non-abortable legacy read retains its concurrency slot until it actually settles.
        const pending = run().finally(() => active.delete(principal.userId));
        return await wait(pending, signal);
      } catch (error) { return toolError(error); }
    },
  };
}
