import uxEvent from './ux-events.schema.json' with { type: 'json' };

/** Public ALMS HTTP API. @alms/ssu-api is the separate server-side school adapter SDK. */
export type JsonSchema = Record<string, unknown>;
type Operation = Record<string, unknown> & { responses: Record<string, unknown> };
const text: JsonSchema = { type: 'string' }, bool: JsonSchema = { type: 'boolean' };
const integer: JsonSchema = { type: 'integer', minimum: 0 }, number: JsonSchema = { type: 'number' };
const instant: JsonSchema = { type: 'string', format: 'date-time' };
const identifier: JsonSchema = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' };
const schoolId: JsonSchema = { type: 'string', pattern: '^[1-9]\\d{0,15}$' };
const uuid: JsonSchema = { type: 'string', format: 'uuid' };
const nonce: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const clientId: JsonSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' };
const enumeration = (...values: string[]): JsonSchema => ({ type: 'string', enum: values });
const nullable = (value: JsonSchema): JsonSchema => ({ anyOf: [value, { type: 'null' }] });
const array = (items: JsonSchema, maxItems?: number): JsonSchema => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
const ref = (name: string): JsonSchema => ({ $ref: '#/components/schemas/' + name });
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties), strict = false): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: !strict,
});
const empty = object({}, [], true);
const file = object({ id: schoolId, fileName: nullable({ ...text, maxLength: 1024 }), contentType: nullable({ ...text, maxLength: 256 }),
  sizeBytes: nullable(integer), downloadAvailable: bool });
const submissionType = enumeration('discussion_topic', 'online_quiz', 'on_paper', 'none', 'external_tool', 'online_text_entry', 'online_url',
  'online_upload', 'media_recording', 'student_annotation', 'basic_lti_launch', 'unknown');
const valueState = enumeration('missing', 'null', 'available', 'withheld');
const workflow = enumeration('unsubmitted', 'submitted', 'graded', 'pending_review', 'unknown');
const completionFields = { moduleItemId: schoolId, weekId: schoolId, moduleCompleted: nullable(bool), personalCompleted: nullable(bool) };
const activityFields = { id: identifier, courseId: identifier, title: text, type: enumeration('video', 'material', 'assignment', 'quiz', 'notice', 'other'),
  resourceType: nullable(enumeration('movie', 'readystream', 'pdf', 'file')),
  sourceUrl: nullable(text), playbackAvailable: bool, progressPercent: nullable(number), schoolStatus: nullable(text), assignmentId: nullable(schoolId),
  dueAt: nullable(instant), unlockAt: nullable(instant), moduleCompleted: nullable(bool), published: nullable(bool), detailAvailable: bool };
const courseFields = { id: identifier, title: text, professor: nullable(text), term: nullable(text), sourceUrl: nullable(text),
  termId: schoolId, ended: nullable(bool), schoolDefaultTerm: bool,
  todoCounts: { type: 'object', additionalProperties: integer } };
const scheduleFields = { id: text, courseId: nullable(identifier), courseTitle: text, dayOfWeek: { type: 'integer', minimum: 1, maximum: 7 },
  startTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' }, endTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
  room: nullable(text), professor: nullable(text) };
const submissionFields = { workflowState: workflow, attempt: nullable(integer), submissionType: nullable(submissionType), submittedAt: nullable(instant),
  gradedAt: nullable(instant), late: nullable(bool), missing: nullable(bool), excused: nullable(bool), gradeMatchesCurrentSubmission: nullable(bool),
  postedAt: nullable(instant), score: nullable(number), grade: nullable(text), scoreState: valueState, gradeState: valueState,
  resultVisibility: enumeration('available', 'not_posted', 'stale', 'unknown'), attachments: nullable(array(file, 100)),
  feedback: nullable(array(object({ id: schoolId, text: nullable(text), createdAt: nullable(instant) }), 100)) };
const assignmentFields = { id: schoolId, courseId: schoolId, title: text, dueAt: nullable(instant), unlockAt: nullable(instant), lockAt: nullable(instant),
  published: nullable(bool), lockedForUser: nullable(bool), submissionTypes: nullable(array(submissionType, 20)),
  allowedExtensions: nullable(array(text, 100)), pointsPossible: nullable({ type: 'number', minimum: 0 }), allowedAttempts: nullable({ type: 'integer', minimum: -1 }),
  sourceUrl: nullable(text), moduleItemId: nullable(schoolId), submissionState: enumeration('missing', 'null', 'available'), submission: nullable(ref('SchoolSubmission')) };
const observationFields = { positionSeconds: { type: 'number', minimum: 0, maximum: 14401 }, durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 14400 },
  playbackRate: { const: 1 }, paused: bool, ended: bool, seeking: { const: false }, visible: { const: true } };
const field = (schema: JsonSchema): JsonSchema => ({ oneOf: [
  object({ state: enumeration('missing', 'null', 'not_applicable'), value: { type: 'null' } }),
  object({ state: { const: 'available' }, value: schema }),
] });
// The event schema remains the canonical analytics allowlist, including new UI versions.
const { $schema: _dialect, $id: _id, ...rawUxEventSchema } = uxEvent;
function relocateUxReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relocateUxReferences);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === '$ref' && typeof child === 'string' && child.startsWith('#/$defs/')
      ? child.replace('#/$defs/', '#/components/schemas/UxEvent/$defs/') : relocateUxReferences(child)]));
  return value;
}
const uxEventSchema = relocateUxReferences(rawUxEventSchema) as JsonSchema;

export const httpSchemas: Record<string, JsonSchema> = {
  Error: object({ error: object({ code: text, message: text, requestId: text }) }, ['error'], true),
  Empty: empty,
  User: object({ id: uuid, displayName: nullable(text) }),
  LegacyCapabilities: object({ schoolAuthentication: bool, schoolRead: bool, playback: bool, pauseResume: bool }),
  AnalyticsIdentity: object({ enabled: { const: true }, collection: { const: 'required' }, configured: bool,
    delivery: enumeration('local', 'posthog_eu'), analyticsId: uuid, sessionId: uuid }),
  Me: object({ user: ref('User'), csrfToken: text, capabilities: ref('LegacyCapabilities'), analytics: ref('AnalyticsIdentity') }),
  Course: object(courseFields, ['id', 'title', 'professor', 'term', 'sourceUrl']),
  CourseTerm: object({ id: schoolId, label: text, year: nullable(integer), current: bool }),
  CourseList: object({ items: array(ref('Course')), term: nullable(text), selectedTermId: nullable(schoolId) }),
  CourseTerms: object({ items: array(ref('CourseTerm')), defaultTermId: nullable(schoolId) }),
  Activity: object(activityFields),
  ActivityDetail: object({ courseId: identifier, moduleItemId: identifier, title: text, descriptionText: nullable(text), type: enumeration('material', 'video'),
    resourceType: nullable(text), published: nullable(bool), opened: nullable(bool), unlockAt: nullable(instant), dueAt: nullable(instant),
    lateAt: nullable(instant), lockAt: nullable(instant), completed: nullable(bool), attendanceStatus: nullable(text), durationSeconds: nullable(number),
    progressSeconds: nullable(number), lastPositionSeconds: nullable(number), progressPercent: nullable(number), fileName: nullable(text), fileSizeBytes: nullable(integer),
    materialViewerUrl: nullable(text), materialContentAvailable: bool, materialViewAvailable: bool, manualVideoAvailable: bool,
    manualVideoReportAvailable: bool, manualVideoProgressMode: nullable(enumeration('untracked', 'not_applicable')), observedAt: instant }),
  Week: object({ id: identifier, number: nullable(integer), title: text, isCurrent: bool, activities: array(ref('Activity')) }),
  CurrentWeek: object({ source: enumeration('school_lesson_dates', 'unavailable'), numbers: array(integer), observedAt: nullable(instant) }),
  CourseContent: object({ course: ref('Course'), weeks: array(ref('Week')), currentWeek: ref('CurrentWeek'), notices: array(ref('Activity')),
    materials: array(ref('Activity')), assignments: array(ref('Activity')), quizzes: array(ref('Activity')),
    categoryScope: object({ materials: { const: 'modules' }, assignments: { const: 'modules' } }),
    availability: object({ weeks: enumeration('available', 'unavailable'), notices: enumeration('available', 'unavailable'),
      materials: enumeration('available', 'unavailable'), assignments: enumeration('available', 'unavailable'), quizzes: enumeration('available', 'unavailable') }) }),
  Schedule: object(scheduleFields),
  Timetable: object({ items: array(ref('Schedule')), term: nullable(text) }),
  SchoolTask: object({ id: text, courseId: identifier, courseTitle: text, title: text, type: activityFields.type,
    dueAt: nullable(instant), sourceUrl: { type: 'null' }, schoolStatus: { type: 'null' }, progressPercent: { type: 'null' },
    playbackAvailable: { const: false }, todoSource: { const: 'school_todo' }, assignmentId: schoolId, ...completionFields },
  ['id', 'courseId', 'courseTitle', 'title', 'type', 'dueAt', 'sourceUrl', 'schoolStatus', 'progressPercent', 'playbackAvailable', 'todoSource']),
  Tasks: object({ items: array(ref('SchoolTask')), courses: array(ref('Course')) }),
  Dashboard: object({ detail: { const: 'overview' }, sourceErrors: { type: 'object', additionalProperties: nullable(text) }, term: nullable(text),
    courses: array(ref('Course')), timetable: array(ref('Schedule')), currentSchedule: nullable(ref('Schedule')),
    currentCourse: nullable(object({ ...courseFields, room: nullable(text), scheduleLabel: text }, ['id', 'title', 'professor', 'term', 'sourceUrl', 'room', 'scheduleLabel'])),
    currentActivities: array(ref('Activity')), upcomingTasks: array(ref('SchoolTask')),
    availability: { type: 'object', additionalProperties: enumeration('available', 'unavailable') } },
  ['term', 'courses', 'timetable', 'currentCourse', 'currentActivities', 'upcomingTasks', 'availability']),
  AttendanceItem: object({ id: text, courseId: identifier, courseTitle: text, title: text, week: integer, date: nullable(instant),
    type: { const: '차시 출결' }, progressPercent: { type: 'null' }, schoolStatus: nullable(text), schoolStatusCode: nullable(text), checkedAt: instant, sourceUrl: { type: 'null' } }),
  Attendance: object({ items: array(ref('AttendanceItem')) }),
  Syllabus: object({ courseId: identifier, title: { const: '강의계획서' }, resourceType: { const: 'pdf' }, documentAvailable: { const: true },
    documentVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' }, sourceUrl: { type: 'null' } }),
  File: file,
  AssignmentCourseContext: object({ id: schoolId, title: text, term: nullable(text), termId: nullable(schoolId), schoolDefaultTerm: nullable(bool), ended: nullable(bool) }),
  SchoolSubmission: object(submissionFields, Object.keys(submissionFields).filter(key => !['postedAt', 'score', 'grade'].includes(key))),
  Assignment: object(assignmentFields),
  AssignmentDetail: object({ ...assignmentFields, descriptionText: nullable(text), lockExplanationText: nullable(text), course: ref('AssignmentCourseContext'),
    descriptionAttachments: array(ref('File'), 100), ownSubmittedContent: nullable(object({ text: nullable(text), url: nullable({ type: 'string', format: 'uri' }) })) },
  [...Object.keys(assignmentFields), 'descriptionText', 'lockExplanationText', 'descriptionAttachments', 'ownSubmittedContent']),
  Assignments: object({ courseId: schoolId, course: ref('AssignmentCourseContext'), items: array(ref('Assignment'), 1000), complete: { const: true } }, ['courseId', 'items', 'complete']),
  AssignmentHistory: object({ courseId: schoolId, assignmentId: schoolId, state: enumeration('available', 'missing', 'null'),
    coverage: { const: 'school_returned' }, observedAt: instant, currentAttempt: nullable(integer), items: nullable(array(object({
      key: { type: 'string', pattern: '^[a-f0-9]{64}$' }, attempt: nullable(integer), submittedAt: nullable(instant), workflowState: workflow,
      submissionType: nullable(submissionType), content: object({ text: field(text), url: field(text) }), attachments: nullable(array(ref('File'), 100)), isCurrent: nullable(bool),
    }), 100)) }),
  CalendarItem: object({ id: identifier, type: enumeration('event', 'assignment'), courseId: schoolId, title: text,
    startsAt: nullable(instant), endsAt: nullable(instant), allDay: bool, allDayDate: nullable({ type: 'string', format: 'date' }), dueAt: nullable(instant),
    assignmentId: nullable(schoolId), sourceUrl: nullable(text), userSubmitted: nullable(bool), ...completionFields },
  ['id', 'type', 'courseId', 'title', 'startsAt', 'endsAt', 'allDay', 'allDayDate', 'dueAt', 'assignmentId', 'sourceUrl', 'userSubmitted']),
  Calendar: object({ start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' }, timeZone: { const: 'Asia/Seoul' },
    courses: array(object({ id: schoolId, title: text }), 100), items: array(ref('CalendarItem'), 2000), complete: { const: true } }),
  PersonalCompletion: object({ courseId: identifier, activityId: identifier, completed: bool, updatedAt: instant }),
  Todo: object({ id: uuid, title: text, completed: bool, dueAt: nullable(instant), createdAt: instant, updatedAt: instant }),
  LearningEvidence: object({ resourceType: enumeration('movie', 'readystream', 'pdf', 'file'), published: nullable(bool), opened: nullable(bool),
    useAttendance: nullable(bool), omitProgress: nullable(bool), completed: nullable(bool),
    schoolAttendanceStatus: nullable(enumeration('attendance', 'absent', 'late', 'none', 'unknown')), progressSeconds: nullable(number),
    lastPositionSeconds: nullable(number), durationSeconds: nullable(number) }),
  SchoolResult: object({ observedAt: instant, progressPercent: nullable({ type: 'number', minimum: 0, maximum: 100 }),
    attendance: enumeration('present', 'absent', 'late', 'pending', 'not_applicable', 'unknown'), recognized: nullable(bool), evidence: ref('LearningEvidence') },
  ['observedAt', 'progressPercent', 'attendance', 'recognized']),
  Job: object({ id: uuid, courseId: identifier, lectureId: identifier,
    status: enumeration('queued', 'scheduled', 'running', 'pause_requested', 'paused', 'cancel_requested', 'cancelled', 'reconciling', 'succeeded', 'completed', 'failed', 'needs_reauthentication', 'needs_verification'),
    scheduledFor: instant, createdAt: instant, updatedAt: instant, schoolResult: nullable(ref('SchoolResult')), errorCode: nullable(text),
    executionOutcome: nullable(enumeration('not_started', 'ended', 'interrupted')), settledAt: nullable(instant),
    settlement: nullable(object({ settledAt: instant, schoolResult: ref('SchoolResult') })),
    recovery: object({ eligible: bool, reason: enumeration('eligible', 'already_settled', 'not_interrupted', 'termination_unconfirmed', 'execution_active', 'lease_active'), version: instant }) },
  ['id', 'courseId', 'lectureId', 'status', 'scheduledFor', 'createdAt', 'updatedAt', 'schoolResult', 'errorCode', 'executionOutcome']),
  SubmissionOperation: object({ id: uuid, courseId: schoolId, assignmentId: schoolId,
    state: enumeration('preparing', 'sending', 'confirmed', 'rejected', 'needs_confirmation'), submissionType: enumeration('online_upload', 'online_text_entry', 'online_url'),
    createdAt: instant, updatedAt: instant, errorCode: nullable(text), receipt: nullable(object({ attempt: nullable(integer), submittedAt: nullable(instant) })),
    reconciliationAvailable: bool,recovery:ref('SubmissionRecovery') }, ['id', 'courseId', 'assignmentId', 'state', 'submissionType', 'createdAt', 'updatedAt', 'errorCode', 'receipt']),
  SubmissionRecovery:object({schoolObservation:nullable(object({workflowState:workflow,attempt:nullable(integer),submittedAt:nullable(instant),observedAt:instant,attribution:{const:'unattributed'}})),release:nullable(object({kind:enumeration('upload_failed_before_submit','school_submission_present'),releasedAt:instant})),releaseAvailable:bool}),
  Upload: object({ id: uuid, status: enumeration('reserved', 'uploading', 'ready', 'consumed'), fileName: text, sizeBytes: integer, expiresAt: instant }),
  UploadInput: object({ fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^\\\\/\\u0000-\\u001f\\u007f]+$', description: 'Trimmed; neither . nor ..' },
    contentType: { type: 'string', maxLength: 128, pattern: '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$' },
    sizeBytes: { type: 'integer', minimum: 1, maximum: 20971520 } }, undefined, true),
  SubmissionInput: { oneOf: ['online_upload', 'online_text_entry', 'online_url'].map(mode => object({ submissionType: { const: mode },
    expectedAttempt: nullable(integer), pledgeAccepted: bool, pledgeDigest: nullable({ type: 'string', pattern: '^[a-f0-9]{64}$' }),
    ...(mode === 'online_upload' ? { uploadIds: { ...array(uuid, 5), minItems: 1, uniqueItems: true } }
      : mode === 'online_text_entry' ? { text: { type: 'string', maxLength: 100000, description: 'Nonblank; UTF-8 bytes ≤120000.' } }
        : { url: { type: 'string', format: 'uri', maxLength: 2048, pattern: '^https?://' } }),
  }, undefined, true)) },
  VideoObservation: object({ ...observationFields, capturedAtMs: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
    description: 'Optional manual-only performance.now() value captured with the actual native media snapshot. Send only after preparation advertises client_monotonic_v1. The first observation fixes timed or legacy mode; never mix, regress, reset or manufacture timestamps. This is not a server clock or a school progress value.' } }, Object.keys(observationFields), true),
  StartObservation: object({ ...observationFields, paused: { const: true }, ended: { const: false } }, undefined, true),
  ManualPlayback: object({ playbackId: uuid, nonce, heartbeatIntervalMs: { const: 5000 }, reportIntervalMs: { const: 300000 },
    maxInitialPositionSeconds: number, state: { const: 'ready' }, observationTiming: { const: 'client_monotonic_v1',
      description: 'Optional capability emitted only when both the installed SDK and this exact prepared driver support the timing contract. Absence preserves legacy observations.' } },
  ['playbackId', 'nonce', 'heartbeatIntervalMs', 'reportIntervalMs', 'maxInitialPositionSeconds', 'state']),
  ManualObservationInput: object({ nonce, sequence: { type: 'integer', minimum: 1, maximum: 100000 }, observation: ref('VideoObservation') }, undefined, true),
  ManualReportInput: object({ nonce, reportSequence: { type: 'integer', minimum: 1, maximum: 100000 }, event: enumeration('playing', 'update', 'unload', 'ended') }, undefined, true),
  MaterialViewInput: object({ event: enumeration('opened', 'page_changed'), page: { type: 'integer', minimum: 1, maximum: 10000 },
    totalPages: { type: 'integer', minimum: 1, maximum: 10000 }, viewedPages: { type: 'array', minItems: 1, maxItems: 10000, uniqueItems: true,
      items: { type: 'integer', minimum: 1, maximum: 10000 } } }, undefined, true),
  UxEvent: uxEventSchema,
  AnalyticsSummary: object({ days: integer, from: instant, through: instant, retentionDays: integer,
    totals: object({ events: integer, sessions: integer }), counts: array(object({ eventName: text, screen: text, count: integer })),
    durations: array(object({ operation: text, outcome: text, count: integer, averageMs: integer, p95Ms: integer })),
    errors: array(object({ code: text, operation: text, count: integer })), buttons: array(object({ action: text, surface: text, count: integer })),
    categories: array(object({ group: text, selected: text, count: integer })),
    frontends: array(object({ clientId: nullable(text), uiVersion: text, count: integer })),
    delivery: object({ pending: integer, sent: integer, retryPending: integer, configured: bool, destination: enumeration('local', 'posthog_eu') }) }),
};

httpSchemas.SubmissionConstraints = object({ modes: array(enumeration('online_upload', 'online_text_entry', 'online_url')),
  allowedExtensions: nullable(array(text)), expectedAttempt: nullable(integer), pledgeRequired: bool,
  maxFileBytes: integer, maxFiles: integer, maxTotalBytes: integer });
httpSchemas.FeatureSupport = object({ supported: bool, availability: enumeration('available', 'unavailable', 'unknown'),
  reason: nullable(enumeration('not_implemented', 'provider_unavailable', 'requires_school_read', 'requires_detail', 'course_read_only',
    'not_published', 'not_opened', 'unsupported_resource', 'progress_not_applicable', 'runtime_not_ready', 'overview_only',
    'school_week_unavailable', 'source_unavailable', 'conditions_unknown', 'locked', 'attempts_exhausted', 'unsupported_mode',
    'group_submission', 'submission_in_progress')),
  scope: enumeration('service', 'course', 'module_collection', 'activity', 'assignment'),
  permissions: object({ read: nullable(bool), write: nullable(bool) }), constraints: nullable(ref('SubmissionConstraints')) });
httpSchemas.FeatureMap = { type: 'object', additionalProperties: ref('FeatureSupport') };
httpSchemas.CurrentActivity = object({ id: identifier, courseId: identifier, weekId: identifier, title: text, type: activityFields.type, resourceType: activityFields.resourceType,
  assignmentId: nullable(schoolId), published: nullable(bool), moduleCompleted: nullable(bool), dueAt: nullable(instant), unlockAt: nullable(instant),
  detailAvailable: bool, playbackAvailable: bool, status: object({ completion: enumeration('completed', 'incomplete', 'unknown'),
    publication: enumeration('published', 'unpublished', 'unknown'), unlock: enumeration('unknown', 'scheduled', 'elapsed') }) });
for (const name of ['CourseContent', 'ActivityDetail', 'AssignmentDetail', 'Assignments', 'Dashboard']) {
  (httpSchemas[name]!.properties as Record<string, JsonSchema>).featureSupport = ref('FeatureMap');
}
(httpSchemas.Me!.properties as Record<string, JsonSchema>).featureSupport = ref('FeatureMap');
(httpSchemas.Me!.properties as Record<string, JsonSchema>).client = object({ id: clientId, authMode: enumeration('cookie', 'bearer') });
(httpSchemas.Me!.required as string[]).push('featureSupport', 'client');
const dashboardProperties = httpSchemas.Dashboard!.properties as Record<string, JsonSchema>;
dashboardProperties.currentActivityItems = array(ref('CurrentActivity'));
(httpSchemas.Dashboard!.required as string[]).push('currentActivityItems');
dashboardProperties.currentCourse = nullable(object({ ...courseFields, room: nullable(text), scheduleLabel: text,
  scheduleStartTime: scheduleFields.startTime, scheduleEndTime: scheduleFields.endTime, timeZone: { const: 'Asia/Seoul' } },
['id', 'title', 'professor', 'term', 'sourceUrl', 'room', 'scheduleLabel', 'scheduleStartTime', 'scheduleEndTime', 'timeZone']));

const json = (schema: JsonSchema) => ({ 'application/json': { schema } });
const errorResponse = { description: 'Normalized failure. Do not use message text as a state code.', content: json(ref('Error')) };
const commonErrors = Object.fromEntries(['400', '401', '403', '404', '409', '413', '415', '429', '500', '502', '503'].map(status => [status, errorResponse]));
const parameters = {
  csrf: { name: 'X-CSRF-Token', in: 'header', required: true, schema: text, description: 'Session CSRF token returned by /v1/me or bearer token exchange. All authenticated writes require it.' },
  origin: { name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' }, description: 'Exact registered origin; required on writes and on every bearer request.' },
  client: { name: 'X-ALMS-Client-Id', in: 'header', required: false, schema: clientId, description: 'Required with bearer authentication. If provided with cookie, must equal the session-bound registered client.' },
  idempotency: { name: 'Idempotency-Key', in: 'header', required: true, schema: uuid, description: 'Reuse only for the identical accepted request. Uncertain writes must be read back, not retried with a new key.' },
  refresh: { name: 'refresh', in: 'query', required: false, schema: { const: '1' }, description: 'Explicit refresh only. No duplicate query parameter.' },
  download: { name: 'download', in: 'query', required: false, schema: { const: '1' } },
};
const paths: Record<string, Record<string, Operation>> = {};
const protectedSecurity = [{ cookieSession: [] }, { bearerSession: [], clientHeader: [] }];
function add(method: string, path: string, summary: string, response: JsonSchema | null, options: {
  status?: number; body?: JsonSchema; queries?: unknown[]; headers?: unknown[]; public?: boolean; description?: string;
  binary?: string; errors?: string[]; pathSchemas?: Record<string, JsonSchema>; redirect?: boolean; bodyType?: string;
} = {}) {
  const requiredPath = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1]!, in: 'path', required: true,
    schema: options.pathSchemas?.[match[1]!] ?? (['operationId', 'playbackId', 'confirmationId', 'uploadId'].includes(match[1]!) || path.startsWith('/v1/jobs/') || path.startsWith('/v1/todos/') ? uuid
      : match[1] === 'attemptKey' ? { type: 'string', pattern: '^[a-f0-9]{64}$' } : match[1] === 'state' ? nonce : identifier) }));
  const writes = !['get', 'head'].includes(method) && !options.public;
  const status = String(options.status ?? 200);
  const success = options.redirect ? { description: 'Registered login continuation only.', headers: { Location: { schema: { type: 'string', format: 'uri' } } } }
    : options.binary ? { description: 'Private owned bytes; no school write.', headers: binaryHeaders(options.binary === 'video/mp4'), content: { [options.binary]: { schema: { type: 'string', format: 'binary' } } } }
      : response ? { description: 'Success', content: json(response) } : { description: 'Success; no response body.' };
  const operation: Operation = { operationId: method + path.replace(/[{}]/g, '').replaceAll('/', '_').replaceAll('-', '_'), summary,
    ...(options.description ? { description: options.description } : {}), security: options.public ? [] : protectedSecurity,
    parameters: [...requiredPath, ...(!options.public ? [parameters.client, ...(writes ? [] : [{ ...parameters.origin, required: false }])] : []), ...(writes ? [parameters.origin, parameters.csrf] : []),
      ...(options.queries ?? []), ...(options.headers ?? [])], responses: { [status]: success, ...commonErrors },
    'x-alms-error-codes': ['INVALID_REQUEST', 'RATE_LIMITED', 'INTERNAL_ERROR', ...(!options.public ? ['AUTH_REQUIRED', 'CLIENT_ORIGIN_INVALID', 'SCHOOL_AUTH_REQUIRED', 'SCHOOL_SESSION_CHANGED', ...(writes ? ['CSRF_INVALID'] : [])] : []), ...(options.errors ?? [])],
    ...(!options.public ? { 'x-alms-bearer-required-headers': ['Authorization', 'X-ALMS-Client-Id', 'Origin'] } : {}),
  };
  if (options.body) operation.requestBody = { required: true, content: { [options.bodyType ?? 'application/json']: { schema: options.body } } };
  (paths[path] ??= {})[method] = operation;
}
function binaryHeaders(range: boolean) {
  return { 'Content-Disposition': { schema: text }, 'Content-Length': { schema: integer },
    'Cache-Control': { schema: { const: 'private, no-store' } }, 'Accept-Ranges': { schema: { const: range ? 'bytes' : 'none' } },
    ...(range ? { 'Content-Range': { schema: text } } : {}) };
}
const query = (name: string, schema: JsonSchema, required = false) => ({ name, in: 'query', required, schema });
const course = '/v1/courses/{id}', activity = course + '/activities/{activityId}', assignment = course + '/assignments/{assignmentId}';
const playbackAccept = { name: 'Accept', in: 'header', required: true, schema: { const: 'application/json; alms-playback=2' },
  description: 'Required when playback is enabled or the job was admitted with school authority.' };

add('get', '/healthz', 'Process health', object({ status: { const: 'ok' } }), { public: true });
add('get', '/readyz', 'Database and runtime readiness', object({ status: { const: 'ready' }, capabilities: ref('LegacyCapabilities'),
  playback: object({ state: enumeration('disabled', 'ready', 'unavailable') }) }), { public: true });
paths['/readyz']!.get!.responses['503'] = { description: 'Database/schema readiness failure', content: json(object({ status: { const: 'not_ready' }, reason: { const: 'database_unavailable' } })) };
add('get', '/version', 'Runtime version', object({ name: { const: 'alms-backend' }, version: text, commit: text }), { public: true });
add('get', '/.well-known/alms-api', 'Public HTTP and optional read-only MCP interface discovery', object({
  contractVersion: { const: '2026-10-22' },
  http: object({ openapi: { type: 'string', format: 'uri' }, featureSupport: { type: 'string', format: 'uri' },
    clientPackage: { const: '@alms/http-client' }, schoolSdkPackage: { const: '@alms/ssu-api' } }),
  mcp: object({ enabled: bool, endpoint: { type: 'string', format: 'uri' }, resourceMetadata: { type: 'string', format: 'uri' },
    readOnly: { const: true }, authorization: { const: 'oauth2_authorization_code_pkce_s256' }, clientId: { const: 'alms-codex' },
    scopes: { type: 'array', items: { const: 'alms:read' }, minItems: 1, maxItems: 1 } }),
}), { public: true, description: 'MCP enabled=false means the optional protocol routes are absent. HTTP feature support still requires /v1/features; discovery never claims that every LMS feature is implemented.' });
add('get', '/openapi.json', 'Current frontend HTTP OpenAPI document', object({ openapi: { const: '3.1.0' }, jsonSchemaDialect: text,
  info: object({ title: text, version: text, description: text }), servers: array(object({ url: text }, ['url'])),
  paths: { type: 'object', description: 'OpenAPI Path Item objects keyed by exact path.' },
  components: { type: 'object', description: 'OpenAPI JSON schemas and security schemes.' } }), { public: true });
const loginQueries = [query('clientId', clientId), query('redirectUri', { type: 'string', format: 'uri', maxLength: 2048 }), query('clientState', nonce),
  query('codeChallenge', nonce), query('codeChallengeMethod', { const: 'S256' }),
  { ...query('returnTo', { type: 'string', maxLength: 2048 }), deprecated: true, description: 'Compatibility field accepted and ignored; never used as a destination.' }];
add('get', '/v1/auth/login', 'Create a one-use school login attempt', object({ url: { type: 'string', format: 'uri' } }), { public: true, queries: loginQueries,
  description: 'Cookie legacy client may omit all queries. Registered bearer clients require clientState, PKCE S256 challenge and an exact registered redirect URI. Never replay the callback.',
  errors: ['SCHOOL_AUTH_UNAVAILABLE', 'INVALID_CLIENT', 'INVALID_REDIRECT_URI', 'PKCE_REQUIRED', 'CLIENT_ORIGIN_INVALID'] });
add('get', '/v1/auth/start', 'Start browser school login', null, { public: true, status: 303, redirect: true, queries: loginQueries,
  description: 'Login success and validated failures return to the registered originating frontend. Same browser binding cookie (Secure SameSite=None in HTTPS) and 15-minute one-use attempt protect the school callback. Invalid client/URI/PKCE before trusted context returns JSON error instead of an arbitrary redirect.',
  errors: ['SCHOOL_AUTH_UNAVAILABLE', 'INVALID_CLIENT', 'INVALID_REDIRECT_URI', 'PKCE_REQUIRED', 'CLIENT_ORIGIN_INVALID'] });
for (const path of ['/v1/auth/callback', '/v1/auth/callback/{state}']) for (const method of ['get', 'post']) {
  const token = { type: 'string', minLength: 1, maxLength: 8192 };
  const student = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' };
  const input = object({ ...(path.endsWith('{state}') ? {} : { state: nonce }), sToken: token, sIdno: student }, [], true);
  add(method, path, 'School SSO callback', null, { public: true, status: 303, redirect: true,
    queries: [...(path.endsWith('{state}') ? [] : [query('state', nonce, method === 'get')]), query('sToken', token, method === 'get'), query('sIdno', student, method === 'get')],
    ...(method === 'post' ? { body: input } : {}), description: 'School-only callback, not a frontend identity endpoint. GET query or POST JSON/form fields must not overlap. Binding cookie, single-use state, expiry and school identity are checked. HTML Accept produces safe 303 failure; JSON failures use Error. No school token is forwarded to frontend.',
    errors: ['INVALID_CALLBACK', 'SCHOOL_AUTH_FAILED', 'SCHOOL_UPSTREAM_UNAVAILABLE', 'SCHOOL_AUTH_UNAVAILABLE'] });
  if (method === 'post') (paths[path]![method]!.requestBody as { content: Record<string, unknown> }).content['application/x-www-form-urlencoded'] = { schema: input };
  if (method === 'post') (paths[path]![method]!.requestBody as { required: boolean }).required = false;
}
add('post', '/v1/auth/token', 'Exchange one-use PKCE code for client-bound bearer session', object({ accessToken: nonce,
  tokenType: { const: 'Bearer' }, expiresAt: instant, csrfToken: text, user: ref('User') }), { public: true,
  headers: [parameters.origin], body: object({ clientId, code: nonce, codeVerifier: { type: 'string', minLength: 43, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' },
    redirectUri: { type: 'string', format: 'uri', maxLength: 2048 } }, undefined, true), description: 'The 60-second code is single-use and bound to client, exact registered URI and S256 verifier. Keep verifier and bearer token in memory. Do not automatically retry exchange.',
  errors: ['AUTH_CODE_INVALID', 'INVALID_CLIENT', 'CLIENT_ORIGIN_INVALID', 'SCHOOL_AUTH_UNAVAILABLE'] });
add('get', '/v1/me', 'Authenticated session and CSRF token', ref('Me'));
add('get', '/v1/features', 'Feature support discovery without school reads', object({ features: ref('FeatureMap') }), {
  description: 'Service support is separate from target availability and permissions. A null permission never authorizes an action; use exact course/activity/assignment featureSupport.',
});
add('patch', '/v1/me/preferences', 'Legacy analytics preference compatibility', object({ analyticsEnabled: { const: true }, collection: { const: 'required' }, configured: bool }),
  { body: object({ analyticsEnabled: bool }, undefined, true), errors: ['ANALYTICS_REQUIRED'], description: 'False is rejected with 409; allowed behavior events are required.' });
add('post', '/v1/auth/logout', 'Revoke this ALMS session', null, { status: 204, description: 'Cookie sessions clear their cookie. Server lectures and reservations keep running per the selected product behavior.' });
add('get', '/v1/dashboard', 'Dashboard data', ref('Dashboard'), { queries: [query('detail', { const: 'overview' })], errors: ['SCHOOL_PROVIDER_UNAVAILABLE'] });
add('get', '/v1/course-terms', 'Owned school term selection', ref('CourseTerms'));
add('get', '/v1/courses', 'Owned course catalog', ref('CourseList'), { queries: [query('termId', schoolId)] });
add('get', course, 'Owned course and all week activities', ref('CourseContent'));
add('get', course + '/completions', 'Owner personal completion overrides', object({ items: array(ref('PersonalCompletion')) }));
add('patch', activity + '/completion', 'Set owner personal completion override', ref('PersonalCompletion'), { body: object({ completed: bool }, undefined, true), errors: ['COURSE_UNAVAILABLE'], description: 'Personal planning only; never school progress, attendance or submission.' });
add('delete', activity + '/completion', 'Restore school completion default', null, { status: 204, description: 'No request body. Deletes only personal override.' });
add('get', course + '/assignments', 'Complete owned assignment list', ref('Assignments'), { queries: [parameters.refresh], errors: ['ASSIGNMENTS_UNAVAILABLE'] });
add('get', assignment, 'Owned assignment instructions, evaluation and own submission', ref('AssignmentDetail'), { queries: [parameters.refresh], pathSchemas: { id: schoolId, assignmentId: schoolId }, errors: ['ASSIGNMENTS_UNAVAILABLE'] });
add('get', assignment + '/files/{fileId}', 'Owned instruction or current submission attachment', null, { binary: 'application/octet-stream', queries: [parameters.download, parameters.refresh],
  description: 'Actual validated MIME is returned; PDF/image/text/octet-stream supported. Original school file name is provided in Content-Disposition. No range support.', pathSchemas: { id: schoolId, assignmentId: schoolId, fileId: schoolId }, errors: ['ASSIGNMENT_FILE_UNAVAILABLE'] });
add('get', assignment + '/submission-history', 'School-returned own submission history', ref('AssignmentHistory'), { queries: [parameters.refresh], pathSchemas: { id: schoolId, assignmentId: schoolId }, errors: ['ASSIGNMENTS_UNAVAILABLE'] });
add('get', assignment + '/submission-history/{attemptKey}/files/{fileId}', 'Owned historical submission attachment', null, { binary: 'application/octet-stream', queries: [parameters.download, parameters.refresh], pathSchemas: { id: schoolId, assignmentId: schoolId, fileId: schoolId } });
const attachmentContent = Object.fromEntries(['application/octet-stream', 'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'image/png', 'image/jpeg', 'image/webp', 'text/plain']
  .map(contentType => [contentType, { schema: { type: 'string', format: 'binary' } }]));
for (const path of [assignment + '/files/{fileId}', assignment + '/submission-history/{attemptKey}/files/{fileId}'])
  (paths[path]!.get!.responses['200'] as { content: unknown }).content = attachmentContent;
add('get', assignment + '/submission-options', 'School submission modes, permissions and limits', object({ supported: bool, modes: array(enumeration('online_upload', 'online_text_entry', 'online_url')),
  blockedReason: nullable(text), allowedExtensions: nullable(array(text)), expectedAttempt: nullable(integer), pledge: object({ required: bool, text: nullable(text), digest: nullable(text) }),
  maxFileBytes: integer, maxFiles: integer, maxTotalBytes: integer, currentOperation: nullable(ref('SubmissionOperation')), featureSupport: ref('FeatureMap') }),
{ pathSchemas: { id: schoolId, assignmentId: schoolId }, errors: ['SUBMISSION_UNAVAILABLE'] });
add('get', assignment + '/submissions/current', 'Current owner submission operation', nullable(ref('SubmissionOperation')), { queries: [query('idempotencyKey', uuid)], pathSchemas: { id: schoolId, assignmentId: schoolId } });
add('get', assignment + '/submissions/{operationId}', 'Exact owner submission operation', ref('SubmissionOperation'), { pathSchemas: { id: schoolId, assignmentId: schoolId } });
add('post', assignment + '/uploads', 'Reserve a temporary owner file upload', ref('Upload'), { status: 201, body: ref('UploadInput'), pathSchemas: { id: schoolId, assignmentId: schoolId } });
add('post', assignment + '/uploads/{uploadId}/content', 'Stream exact reserved file bytes', ref('Upload'), { body: { type: 'string', format: 'binary' }, bodyType: 'application/octet-stream',
  description: 'Exact reserved size and type, authenticated before streaming; 20 MiB maximum. Files remain temporary until final school submission.', pathSchemas: { id: schoolId, assignmentId: schoolId }, errors: ['INVALID_UPLOAD'] });
add('post', assignment + '/uploads/{uploadId}/cancel', 'Delete temporary owner upload', null, { status: 204, body: empty, pathSchemas: { id: schoolId, assignmentId: schoolId } });
add('post', assignment + '/submissions', 'Submit designated final assignment content', ref('SubmissionOperation'), { status: 202, headers: [parameters.idempotency], body: ref('SubmissionInput'), pathSchemas: { id: schoolId, assignmentId: schoolId },
  description: 'School modes/locks/attempt/pledge/generation revalidated; at most 5 files and 40 MiB total. Acceptance is not school confirmation. Poll operation; do not retry uncertain school writes with a new key.', errors: ['SUBMISSION_UNAVAILABLE', 'SUBMISSION_PENDING', 'IDEMPOTENCY_CONFLICT'] });
add('post', assignment + '/submissions/{operationId}/reconcile', 'Read fresh own school submission and compare an exact receipt when present', ref('SubmissionOperation'), { body: empty, pathSchemas: { id: schoolId, assignmentId: schoolId },
  description: 'Works for unresolved operations even without a receipt. Current school state is unattributed observation, never proof ALMS submitted it. Exact receipt match alone can confirm the original operation. No school write, automatic release or retry.' });
add('post', assignment + '/submissions/{operationId}/release', 'Explicitly release an ended uncertain operation blocker',ref('SubmissionOperation'),{body:object({observedAt:instant},['observedAt'],true),pathSchemas:{id:schoolId,assignmentId:schoolId},description:'Fresh school read, observation/generation CAS and exclusive local claim required. Original outcome/state/error/times and idempotency remain. Legacy unsubmitted operations without durable pre-final termination evidence cannot release. No school write, automatic new draft or retry.',errors:['RECOVERY_CHANGED','RECOVERY_UNAVAILABLE','SUBMISSION_BUSY']});
add('get', activity, 'Owned activity details', ref('ActivityDetail'), { headers: [{ name: 'Accept', in: 'header', required: false,
  schema: { const: 'application/json; alms-manual-video=untracked' }, description: 'Exact representation required to expose attendance-bearing manual media. It is still untracked unless the separate report APIs are used.' }] });
add('get', activity + '/material', 'Owned PDF bytes', null, { binary: 'application/pdf', queries: [parameters.refresh], errors: ['MATERIAL_UNAVAILABLE', 'MATERIAL_REFRESHED'] });
add('get', activity + '/media', 'Owned manual MP4 stream', null, { binary: 'video/mp4', headers: [{ name: 'Range', in: 'header', required: false, schema: text }],
  description: 'No query. Single bytes range; 200 or 206, invalid range 416. Bytes alone never report progress. Native video works with same-site cookie auth; a bearer client must fetch authenticated bytes/stream through its transport. No tokens in media URLs.', errors: ['VIDEO_BUSY', 'VIDEO_UNAVAILABLE', 'VIDEO_RANGE_INVALID'] });
paths[activity + '/media']!.get!.responses['206'] = { description: 'Single byte range', headers: binaryHeaders(true), content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } } };
paths[activity + '/media']!.get!.responses['416'] = errorResponse;
add('post', activity + '/view', 'Report PDF pages actually displayed', object({ activity: ref('ActivityDetail'), report: enumeration('recorded', 'already_completed') }), { body: ref('MaterialViewInput'),
  description: 'Current page must be within totalPages and included in unique viewedPages. No report during preload/download. Recorded ACK is not completion or attendance; use returned school fields.', errors: ['MATERIAL_VIEW_UNAVAILABLE'] });
add('get', activity + '/learning-status', 'Fresh owned school learning result', object({ courseId: schoolId, activityId: schoolId, schoolResult: ref('SchoolResult'), stateChanged: { const: false } }),
  { pathSchemas: { id: schoolId, activityId: schoolId }, errors: ['SCHOOL_RESULT_UNAVAILABLE', 'LEARNING_STATUS_BUSY'], description: 'Read-only; no playback, school write or local completion synthesis.' });
const manualTraceHeader = { name: 'X-ALMS-Trace-Id', in: 'header', required: false, schema: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }, description: 'Optional fresh random UUID v4 for transport correlation only. Never a school, user or playback identifier. Invalid values are ignored; authentication and write conditions are unchanged.' };
add('post', activity + '/manual-playback', 'Prepare process-bound manual progress lifetime', ref('ManualPlayback'), { headers: [manualTraceHeader], body: empty, pathSchemas: { id: schoolId, activityId: schoolId }, errors: ['VIDEO_REPORT_UNAVAILABLE', 'PLAYBACK_BUSY'] });
add('post', activity + '/manual-playback/{playbackId}/observations', 'Observe real visible normal playback', object({ playbackId: uuid, sequence: integer, state: { const: 'ready' } }),
  { headers: [manualTraceHeader], body: ref('ManualObservationInput'), pathSchemas: { id: schoolId, activityId: schoolId }, description: 'Exact sequential heartbeat at normal 1x, no seeking. Sequence is previous accepted value +1. Lifetime expires after 15 seconds without an accepted observation. Optional capturedAtMs is manual-only and requires the exact prepared driver timing capability; it never replaces server freshness or authorizes extra progress. Reports and explicit school restart observations are unchanged.', errors: ['PLAYBACK_OBSERVATION_INVALID', 'PLAYBACK_SESSION_EXPIRED'] });
add('post', activity + '/manual-playback/{playbackId}/reports', 'Report observed manual school progress', object({ playbackId: uuid, reportSequence: integer,
  state: enumeration('ready', 'closed'), report: enumeration('acknowledged', 'unknown'), schoolResult: ref('SchoolResult') }),
  { headers: [manualTraceHeader], body: ref('ManualReportInput'), pathSchemas: { id: schoolId, activityId: schoolId }, description: 'Sequential playing/update/unload/ended report after accepted real observation. Update is at least 300000 ms after previous report. Unknown response must not be replayed automatically; read school result.', errors: ['PLAYBACK_REPORT_UNKNOWN', 'PLAYBACK_OBSERVATION_INVALID', 'PLAYBACK_SESSION_EXPIRED'] });
add('post', activity + '/manual-playback/{playbackId}/stop', 'Dispose exact local manual lifetime', object({ playbackId: uuid, state: { const: 'closed' } }),
  { headers: [manualTraceHeader], body: object({ nonce }, undefined, true), pathSchemas: { id: schoolId, activityId: schoolId }, description: 'Local stop is not a school report acknowledgement.' });
add('post', activity + '/playback-start-confirmations', 'Prepare explicit school progress restart confirmation', object({ confirmationId: uuid, nonce, expiresAt: instant }),
  { body: empty, pathSchemas: { id: schoolId, activityId: schoolId }, description: 'Two-minute, exact-owner/session/target/process bound confirmation; no school restart yet.', errors: ['PLAYBACK_START_UNAVAILABLE', 'PLAYBACK_BUSY'] });
add('post', activity + '/playback-start-confirmations/{confirmationId}/confirm', 'Confirm explicit school progress restart once', { oneOf: [
  object({ state: { const: 'confirmed' }, confirmedAt: instant, schoolResult: ref('SchoolResult') }),
  object({ state: { const: 'verification_required' }, confirmedAt: { type: 'null' }, schoolResult: ref('SchoolResult') }),
] }, { body: object({ nonce, observation: ref('StartObservation') }, undefined, true), pathSchemas: { id: schoolId, activityId: schoolId },
  description: 'Only after user impact confirmation and paused visible 1x player observation. May interrupt another school content progress. Unknown write cannot be automatically repeated.', errors: ['PLAYBACK_START_UNAVAILABLE', 'PLAYBACK_START_CONSUMED', 'PLAYBACK_START_EXPIRED', 'PLAYBACK_BUSY'] });
add('get', course + '/syllabus', 'Owned syllabus metadata', ref('Syllabus'), { queries: [parameters.refresh], errors: ['SYLLABUS_UNAVAILABLE'] });
add('get', course + '/syllabus/material', 'Owned syllabus PDF', null, { binary: 'application/pdf', queries: [parameters.refresh], errors: ['SYLLABUS_UNAVAILABLE'] });
add('get', '/v1/timetable', 'Owned u-SAINT timetable', ref('Timetable'));
add('get', '/v1/attendance', 'School lesson attendance', ref('Attendance'), { queries: [query('courseId', identifier)] });
add('get', '/v1/tasks', 'School pending activities with exact module links', ref('Tasks'), { description: 'Feed is pending school activities, not proof of item submission. Personal override is separate and comes from this owner on each read.' });
add('get', '/v1/calendar', 'Owned school calendar range', ref('Calendar'), { queries: [query('start', { type: 'string', format: 'date' }, true), query('end', { type: 'string', format: 'date' }, true), query('courseId', schoolId), parameters.refresh],
  description: 'Seoul [start,end), 1–31 days; dates2000–2100. School userSubmitted and personalCompleted remain independent.', errors: ['CALENDAR_UNAVAILABLE'] });
add('get', '/v1/todos', 'Owner personal TODO list (at most 500)', object({ items: array(ref('Todo'), 500), complete: bool, hasMore: bool, limit: { const: 500 } }), {
  description: 'Newest personal TODOs, ordered by createdAt then id descending. complete and hasMore are exact inverses for this owner at the query snapshot, based on one extra bounded row. They describe list truncation, not task completion. No cursor or total count is provided.',
});
const todoTitle = { type: 'string', minLength: 1, maxLength: 240, description: 'Trimmed nonblank title.' };
add('post', '/v1/todos', 'Create personal TODO', ref('Todo'), { status: 201, body: object({ title: todoTitle, dueAt: nullable(instant) }, ['title'], true) });
add('patch', '/v1/todos/{id}', 'Update owner TODO', ref('Todo'), { body: { ...object({ title: todoTitle, dueAt: nullable(instant), completed: bool }, [], true), minProperties: 1 } });
add('delete', '/v1/todos/{id}', 'Delete owner TODO', null, { status: 204 });
add('get', '/v1/jobs', 'Owner playback jobs (at most 200)', object({ items: array(ref('Job'), 200), complete: bool, hasMore: bool, limit: { const: 200 } }), { queries: [query('courseId', identifier)], headers: [playbackAccept], errors: ['CLIENT_UPDATE_REQUIRED'],
  description: 'Newest owner jobs in the optional exact course scope, ordered by createdAt then id descending. complete and hasMore are exact inverses at the query snapshot, based on one extra bounded row. They describe list truncation, not execution or school completion. No cursor or total count is provided. Only returned jobs receive result-cache refresh.',
});
add('post', '/v1/jobs', 'Accept a separate server lecture job', ref('Job'), { status: 202, body: object({ courseId: identifier, lectureId: identifier, scheduledFor: instant }, ['courseId', 'lectureId'], true), headers: [parameters.idempotency, playbackAccept],
  description: 'Schedule at most1year ahead. Admission checks live worker readiness, school ownership and generation;202 is not completion. Read jobs on uncertain acceptance.', errors: ['PLAYBACK_UNAVAILABLE', 'PLAYBACK_ADMISSION_UNCONFIRMED', 'IDEMPOTENCY_CONFLICT', 'JOB_ALREADY_ACTIVE', 'INVALID_SCHEDULE', 'CLIENT_UPDATE_REQUIRED'] });
add('get', '/v1/jobs/{id}', 'Exact owned playback job', ref('Job'), { headers: [playbackAccept], errors: ['CLIENT_UPDATE_REQUIRED'] });
add('get', '/v1/jobs/{id}/verify', 'Read exact job school result', object({ job: ref('Job'), schoolResult: ref('SchoolResult'), stateChanged: { const: false } }),
  { headers: [playbackAccept], description: 'Fresh read-only result; job state/history are preserved.', errors: ['SCHOOL_RESULT_UNAVAILABLE', 'JOB_CHANGED', 'JOB_VERIFICATION_BUSY', 'CLIENT_UPDATE_REQUIRED'] });
add('post', '/v1/jobs/{id}/cancel', 'Request cancellation of owner job', ref('Job'), { headers: [playbackAccept], errors: ['CLIENT_UPDATE_REQUIRED'] });
for (const action of ['pause', 'resume']) add('post', '/v1/jobs/{id}/' + action, 'Unsupported school pause/resume control', null, { status: 503, headers: [playbackAccept], errors: ['PLAYBACK_CONTROL_UNAVAILABLE', 'CLIENT_UPDATE_REQUIRED'] });
add('post', '/v1/jobs/{id}/settle', 'Record verified local recovery settlement', object({ job: ref('Job'), settlementRecorded: { const: true }, stateChanged: { const: false } }),
  { body: object({ expectedUpdatedAt: instant, confirmed: { const: true } }, undefined, true), headers: [playbackAccept],
    description: 'Requires exact recovery version, actual termination proof and no active execution/lease. Keeps original failure/result and stores settlement separately; no auto restart.',
    errors: ['JOB_SETTLEMENT_UNCONFIRMED', 'JOB_SETTLEMENT_UNAVAILABLE', 'JOB_SETTLEMENT_UNSAFE', 'JOB_SETTLEMENT_BUSY', 'JOB_CHANGED', 'CLIENT_UPDATE_REQUIRED'] });
add('post', '/v1/analytics/events', 'Durably accept allowlisted behavior event', object({ accepted: { const: true }, reason: enumeration('stored', 'duplicate') }),
  { status: 202, body: ref('UxEvent'), description: 'Server replaces analytics/session identities. No student content, credentials, original URLs, replay or auto DOM capture. ui_version distinguishes frontend UI releases.', errors: ['EVENT_ID_CONFLICT'] });
add('get', '/v1/analytics/summary', 'Owner analytics summary', ref('AnalyticsSummary'), { queries: [query('days', { type: 'integer', minimum: 1, maximum: 365, default: 7 })] });

// Fastify automatically supplies HEAD for every GET. It has the same auth/headers/statuses, no body.
for (const operations of Object.values(paths)) if (operations.get && !operations.head) {
  const head = structuredClone(operations.get);
  head.operationId = String(head.operationId).replace(/^get_/, 'head_');
  head.summary = 'Headers only: ' + head.summary;
  for (const response of Object.values(head.responses)) delete (response as { content?: unknown }).content;
  operations.head = head;
}

export const httpOpenApi = {
  openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: { title: 'ALMS frontend HTTP API', version: '1.0.0', description: '숭실대학교 전용 ALMS Backend API. Current source contract; release and production QA evidence are separate. School adapter SDK @alms/ssu-api is not the frontend HTTP client.' },
  servers: [{ url: 'https://api-lms.flyjung.kr' }, { url: 'http://127.0.0.1:4300', description: 'Local development' }],
  paths, components: { schemas: httpSchemas, securitySchemes: {
    cookieSession: { type: 'apiKey', in: 'cookie', name: '__Host-alms_session', description: 'Default HttpOnly Secure SameSite=Lax cookie. Registered nondefault cookie clients use __Host-alms_session_{clientId}; development HTTP uses alms_session_dev[_clientId]. Select with client header or unique registered Origin. Different-site frontends use PKCE bearer.' },
    bearerSession: { type: 'http', scheme: 'bearer', description: 'Client-bound opaque token from /v1/auth/token; exact registered Origin and client header required.' },
    clientHeader: { type: 'apiKey', in: 'header', name: 'X-ALMS-Client-Id' },
  } },
  'x-alms-query-policy': 'Strictly validated query objects reject extra, duplicate, or unsupported values where stated. Path/body identity never authenticates an owner.',
  'x-alms-head-policy': 'HEAD is automatically registered for each GET and returns no body.',
  'x-alms-cors-policy': 'OPTIONS wildcard is CORS transport infrastructure, not a data operation. Only exact registered/allowed origins receive credentialed CORS.',
};

export function serializeHttpOpenApi(): string { return JSON.stringify(httpOpenApi, null, 2) + '\n'; }
