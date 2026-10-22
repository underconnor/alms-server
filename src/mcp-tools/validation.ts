import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { httpSchemas } from '../contracts/http-openapi.js';
import { AppError } from '../errors.js';

type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
function relocate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relocate);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === '$ref' && typeof child === 'string' ? child.replace('#/components/schemas/', '#/$defs/') : relocate(child)]));
  return value;
}
const ajv = new Ajv2020({ allErrors: false, strict: false });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
const definitions = relocate(httpSchemas);
const validators = new Map<string, ReturnType<Ajv2020['compile']>>();
export function checked(name: string, value: unknown): JsonObject {
  let validate = validators.get(name);
  if (!validate) {
    if (!httpSchemas[name]) throw new Error('Unknown ALMS response schema');
    validate = ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions, $ref: '#/$defs/' + name });
    validators.set(name, validate);
  }
  // Neither Ajv error details nor rejected school data are returned or logged.
  if (!validate(value) || !record(value)) throw new AppError(502, 'MCP_SOURCE_INVALID', '학교 응답 형식을 확인하지 못했습니다.');
  return value;
}

const excluded = new Set(['sourceUrl', 'materialViewerUrl', 'url', 'playbackAvailable', 'manualVideoAvailable',
  'manualVideoReportAvailable', 'manualVideoProgressMode', 'materialContentAvailable', 'materialViewAvailable', 'downloadAvailable']);
const readFeatures = new Set(['authentication', 'courses', 'course_terms', 'weeks', 'notices', 'materials', 'assignments',
  'assignment_detail', 'assignment_history', 'quizzes', 'attendance', 'timetable', 'tasks', 'calendar', 'learning_status']);
const prose = new Set(['descriptionText', 'lockExplanationText', 'text']);
export type Projection = { textTruncated: boolean; textLimit: number };

/** Project only documented fields, never forward the provider's additionalProperties.
 * URLs/byte and playback controls are intentionally absent from this read-only representation. */
export function project(name: string, value: unknown, state: Projection): unknown {
  const walk = (schema: unknown, input: unknown, key = ''): unknown => {
    if (!record(schema)) return undefined;
    if (typeof schema.$ref === 'string') return walk(httpSchemas[schema.$ref.split('/').at(-1)!], input, key);
    const choices = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(choices)) {
      if (input === null) return null;
      const selected = choices.find(choice => record(choice) && choice.type !== 'null');
      return walk(selected, input, key);
    }
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') {
      if (prose.has(key) && input.length > state.textLimit) { state.textTruncated = true; return input.slice(0, state.textLimit); }
      return input;
    }
    if (Array.isArray(input)) return input.map(item => walk(schema.items, item));
    if (record(input)) {
      if (key === 'featureSupport') return features(input);
      if (key === 'todoCounts') return Object.fromEntries(Object.entries(input).filter(([name, amount]) =>
        /^total_[a-z_]{1,80}$/.test(name) && Number.isSafeInteger(amount) && Number(amount) >= 0));
      const properties = record(schema.properties) ? schema.properties : {};
      return Object.fromEntries(Object.entries(properties).filter(([name]) => !excluded.has(name) && Object.hasOwn(input, name))
        .map(([name, child]) => [name, walk(child, input[name], name)]));
    }
    return input;
  };
  return walk(httpSchemas[name], value);
}

export function features(value: unknown) {
  const map = checked('FeatureMap', value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(map)) if (readFeatures.has(key)) {
    const safe = project('FeatureSupport', item, { textLimit: 0, textTruncated: false }) as JsonObject;
    result[key] = safe;
  }
  return result;
}

export function equalTarget(value: unknown, expected: string, key = 'courseId') {
  if (!record(value) || value[key] !== expected) throw new AppError(502, 'MCP_SOURCE_INVALID', '선택한 학교 항목을 확인하지 못했습니다.');
}
export function object(value: unknown): JsonObject { return value as JsonObject; }
export function rows(value: unknown): JsonObject[] { return value as JsonObject[]; }
