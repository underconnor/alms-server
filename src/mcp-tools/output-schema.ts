import { httpSchemas, type JsonSchema } from '../contracts/http-openapi.js';

const excluded = new Set(['sourceUrl', 'materialViewerUrl', 'url', 'playbackAvailable', 'manualVideoAvailable',
  'manualVideoReportAvailable', 'manualVideoProgressMode', 'materialContentAvailable', 'materialViewAvailable', 'downloadAvailable']);
const readFeatures = ['authentication', 'courses', 'course_terms', 'weeks', 'notices', 'materials', 'assignments',
  'assignment_detail', 'assignment_history', 'quizzes', 'attendance', 'timetable', 'tasks', 'calendar', 'learning_status'];
const errorCodes = ['MCP_READ_FAILED', 'MCP_INVALID_ARGUMENTS', 'AUTH_REQUIRED', 'MCP_AUTH_REQUIRED', 'MCP_SCOPE_INSUFFICIENT',
  'SCHOOL_AUTH_REQUIRED', 'SCHOOL_AUTH_FAILED', 'SCHOOL_SESSION_CHANGED', 'SCHOOL_UPSTREAM_UNAVAILABLE', 'MCP_SOURCE_INVALID',
  'MCP_RESPONSE_TOO_LARGE', 'MCP_FEATURE_UNAVAILABLE', 'MCP_CANCELLED', 'SCHOOL_PROVIDER_UNAVAILABLE', 'MCP_RESOURCE_UNSUPPORTED',
  'MCP_TIMEOUT', 'MCP_BUSY', 'RATE_LIMITED', 'NOT_FOUND'];
const bool: JsonSchema = { type: 'boolean' };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
});
const array = (items: JsonSchema, maximum?: number): JsonSchema => ({ type: 'array', items, ...(maximum === undefined ? {} : { maxItems: maximum }) });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Mirrors the documented read projection, not a permissive copy of REST additionalProperties.
 * References are inlined so every tool is a standalone JSON Schema without HTTP-only definitions. */
function projected(name: string): JsonSchema {
  const walk = (input: unknown, key = ''): JsonSchema => {
    if (!record(input)) throw new Error('Invalid MCP source schema');
    if (typeof input.$ref === 'string') return projected(input.$ref.split('/').at(-1)!);
    if (key === 'todoCounts') return { type: 'object', patternProperties: { '^total_[a-z_]{1,80}$': { type: 'integer', minimum: 0 } }, additionalProperties: false };
    const result: JsonSchema = {};
    for (const [field, value] of Object.entries(input)) {
      if (['properties', 'required', 'additionalProperties', '$ref'].includes(field)) continue;
      if (field === 'items') result.items = walk(value);
      else if (field === 'anyOf' || field === 'oneOf' || field === 'allOf') result[field] = (value as unknown[]).map(item => walk(item, key));
      else result[field] = structuredClone(value);
    }
    if (record(input.properties)) {
      const properties: Record<string, JsonSchema> = {};
      for (const [field, child] of Object.entries(input.properties)) {
        if (excluded.has(field)) continue;
        properties[field] = field === 'featureSupport' ? featureMap() : walk(child, field);
      }
      result.properties = properties;
      result.required = Array.isArray(input.required) ? input.required.filter(field => typeof field === 'string' && Object.hasOwn(properties, field)) : [];
      result.additionalProperties = false;
    }
    if (['descriptionText', 'lockExplanationText', 'text'].includes(key) && result.type === 'string')
      result.maxLength = Math.min(typeof result.maxLength === 'number' ? result.maxLength : 30_000, 30_000);
    return result;
  };
  const source = httpSchemas[name]; if (!source) throw new Error('Unknown MCP output model');
  return walk(source);
}
function featureMap(): JsonSchema {
  return object(Object.fromEntries(readFeatures.map(name => [name, projected('FeatureSupport')])), []);
}
function properties(name: string): Record<string, JsonSchema> {
  return projected(name).properties as Record<string, JsonSchema>;
}
function boundedModel(name: string, itemModel: string): JsonSchema {
  const result = projected(name), fields = result.properties as Record<string, JsonSchema>;
  fields.items = array(projected(itemModel), 200); return result;
}
const course = () => projected('Course');
const assignmentCollection = () => object({ courseId: properties('Assignments').courseId!, course: projected('AssignmentCourseContext'),
  items: array(projected('Assignment'), 200), featureSupport: featureMap() }, ['courseId', 'items']);

function dataFor(name: string): JsonSchema {
  switch (name) {
    case 'alms_get_capabilities': return object({ schoolFeatures: featureMap(), mcpPolicy: object({ scope: { const: 'alms:read' },
      schoolWrites: { const: false }, materialBytes: { const: false }, automaticPlayback: { const: false } }) });
    case 'alms_list_terms': return boundedModel('CourseTerms', 'CourseTerm');
    case 'alms_list_courses': return boundedModel('CourseList', 'Course');
    case 'alms_get_course': {
      const week = projected('Week'); (week.properties as Record<string, JsonSchema>).activities = array(projected('Activity'), 200);
      return object({ course: course(), weeks: array(week), currentWeek: projected('CurrentWeek'),
        categoryScope: object({ materials: { const: 'modules' }, assignments: { const: 'modules' } }), featureSupport: featureMap() },
      ['course', 'weeks', 'currentWeek', 'categoryScope']);
    }
    case 'alms_get_activity': return projected('ActivityDetail');
    case 'alms_list_assignments': return assignmentCollection();
    case 'alms_get_assignment': return projected('AssignmentDetail');
    case 'alms_list_tasks': return object({ items: array(projected('SchoolTask'), 200), courses: array(course()) });
    case 'alms_get_calendar': {
      const fields = properties('Calendar');
      return object({ start: fields.start!, end: fields.end!, timeZone: fields.timeZone!, courses: fields.courses!, items: array(projected('CalendarItem'), 200) });
    }
    case 'alms_get_timetable': return object({ term: properties('Timetable').term!, items: array(projected('Schedule'), 200) });
    case 'alms_get_attendance': return object({ items: array(projected('AttendanceItem'), 200) });
    case 'alms_get_learning_status': return object({ courseId: properties('ActivityDetail').courseId!, activityId: properties('ActivityDetail').moduleItemId!, schoolResult: projected('SchoolResult') });
    default: throw new Error('Unknown MCP output tool');
  }
}

const lists = new Set(['alms_list_terms', 'alms_list_courses', 'alms_get_course', 'alms_list_assignments', 'alms_list_tasks',
  'alms_get_calendar', 'alms_get_timetable', 'alms_get_attendance']);
/** Success and normalized tool errors have explicit, mutually exclusive envelopes. */
export function mcpOutputSchema(name: string): JsonSchema {
  const meta = object({ source: { const: name === 'alms_get_capabilities' ? 'ALMS' : 'school' }, schoolRecordWrites: { const: false }, textTruncated: bool,
    ...(lists.has(name) ? { limit: { type: 'integer', minimum: 1, maximum: 200 }, returnedCount: { type: 'integer', minimum: 0, maximum: 200 },
      hasMore: bool, truncated: bool, complete: { anyOf: [bool, { type: 'null' }] } } : {}) });
  if (lists.has(name)) meta.allOf = [{ if: { properties: { hasMore: { const: true } } },
    then: { properties: { truncated: { const: true }, complete: { const: false } } },
    else: { properties: { truncated: { const: false }, complete: { anyOf: [{ const: true }, { type: 'null' }] } } } }];
  const success = object({ data: dataFor(name), meta });
  const failure = object({ error: object({ code: { type: 'string', enum: errorCodes }, message: { type: 'string', maxLength: 256 }, schoolReauthenticationRequired: bool }) });
  return structuredClone({ type: 'object', oneOf: [success, failure] });
}
