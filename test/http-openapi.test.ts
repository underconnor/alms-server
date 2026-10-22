import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { httpOpenApi, httpSchemas, serializeHttpOpenApi } from '../src/contracts/http-openapi.js';
import { publicCourseContent, createLearningxReads, type LearningxReader } from '../src/school-read.js';
import { createCombinedDashboard } from '../src/school-dashboard.js';
import { publicAssignments, publicAssignmentDetail } from '../src/assignments.js';
import { publicAssignmentHistory } from '../src/assignment-history.js';
import { providerFeatures, submissionFeature } from '../src/feature-support.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';
import { historyFixture } from './helpers/assignment-history-fixture.js';
import { uploadInput, submissionInput } from '../src/assignment-submission-types.js';

function schemasForAjv(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schemasForAjv);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === '$ref' && typeof child === 'string' ? child.replace('#/components/schemas/', '#/$defs/') : schemasForAjv(child)]));
  return value;
}
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
const definitions = schemasForAjv(httpSchemas);
const validators = new Map(Object.keys(httpSchemas).map(name => [name, ajv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions, $ref: '#/$defs/' + name,
})]));
function matches(name: string, value: unknown) {
  const validate = validators.get(name)!;
  assert.equal(validate(value), true, name + ': ' + JSON.stringify(validate.errors));
}
function normalize(path: string) { return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}'); }

test('OpenAPI covers every actual registered method and path, including automatic HEAD', async () => {
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), {} as Store);
  try {
    await app.ready();
    // Fastify's public route inventory is tree-shaped even when commonPrefix=false.
    const stack: string[] = [], actual: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^([│ ]*)[├└]── (\/\S*|\*) \(([^)]+)\)$/.exec(line);
      if (!match) continue;
      const depth = match[1]!.length / 4, segment = match[2]!;
      if (segment === '*') { assert.equal(match[3], 'OPTIONS'); continue; }
      assert.equal(Number.isInteger(depth), true, line);
      const path = depth === 0 ? segment : stack[depth - 1]! + segment;
      stack[depth] = path; stack.length = depth + 1;
      for (const method of match[3]!.split(', ')) actual.push(method.toLowerCase() + ' ' + normalize(path));
    }
    const declared = Object.entries(httpOpenApi.paths).flatMap(([path, operations]) => Object.keys(operations).map(method => method + ' ' + path));
    assert.ok(actual.length > 80, 'Inventory parser must see the full application.');
    assert.deepEqual(actual.sort(), declared.sort());
  } finally { await app.close(); }
});

test('generated static contract is byte-identical and public route provides the same document', async () => {
  assert.equal(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'), serializeHttpOpenApi());
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), {} as Store);
  try {
    const response = await app.inject('/openapi.json');
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), httpOpenApi);
  } finally { await app.close(); }
});

test('contract declares protection, exact compatibility Accept values and request bodies', () => {
  const ids: string[] = [];
  for (const [path, methods] of Object.entries(httpOpenApi.paths)) for (const [method, operation] of Object.entries(methods)) {
    ids.push(String(operation.operationId));
    assert.ok(Object.keys(operation.responses).length);
    const parameters = operation.parameters as Array<{ name: string; required: boolean; in: string; schema: any }>;
    if (method === 'head') for (const response of Object.values(operation.responses)) assert.equal('content' in (response as object), false);
    if (!['get', 'head'].includes(method) && (operation.security as unknown[]).length) {
      assert.ok(parameters.some(item => item.name === 'Origin' && item.required));
      assert.ok(parameters.some(item => item.name === 'X-CSRF-Token' && item.required));
    }
    if (path === '/v1/jobs' || path === '/v1/jobs/{id}' || path.startsWith('/v1/jobs/{id}/')) {
      assert.ok(parameters.some(item => item.name === 'Accept' && item.schema.const === 'application/json; alms-playback=2'));
    }
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const name of Object.keys(httpSchemas)) assert.ok(validators.has(name), name);
});

test('bounded list contracts require exact additive completeness metadata without changing item caps', () => {
  for (const [path, limit] of [['/v1/todos', 500], ['/v1/jobs', 200]] as const) {
    const response = httpOpenApi.paths[path]!.get!.responses['200'] as { content: { 'application/json': { schema: Record<string, unknown> } } };
    const schema = response.content['application/json'].schema;
    const validate = ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions, ...schemasForAjv(schema) as object });
    for (const body of [{ items: [], complete: true, hasMore: false, limit }, { items: [], complete: false, hasMore: true, limit }]) {
      assert.equal(validate(body), true, JSON.stringify(validate.errors));
      for (const field of ['complete', 'hasMore', 'limit']) { const invalid: Record<string, unknown> = { ...body }; delete invalid[field]; assert.equal(validate(invalid), false); }
      assert.equal(validate({ ...body, limit: limit + 1 }), false);
    }
    assert.equal((schema.properties as Record<string, { maxItems?: number }>).items!.maxItems, limit);
  }
});

test('real public projections validate against supported contract response models', async () => {
  const course = { id: '10', title: '합성 강좌', professor: null, term: null, sourceUrl: null };
  matches('CourseContent', publicCourseContent({ course, modules: [] }));
  matches('Assignments', publicAssignments(assignmentListFixture(), '10'));
  matches('AssignmentDetail', publicAssignmentDetail(assignmentFixture(), '10', '90'));
  matches('AssignmentHistory', publicAssignmentHistory(historyFixture(), '10', '90'));
  const featureMap = providerFeatures(unavailableSchoolProvider, { assignmentSubmission: false, manualVideo: false, playbackStart: false, playbackReady: false });
  matches('FeatureMap', featureMap);
  matches('FeatureSupport', submissionFeature({ supported: true, modes: ['online_upload'], blockedReason: null, allowedExtensions: ['pdf'],
    expectedAttempt: 1, pledge: { required: true, text: '합성 문구', digest: 'a'.repeat(64) }, generation: 'private' }));
  const reader = { catalog: async () => ({ courses: [course], term: null, termIds: [] }) } as unknown as LearningxReader;
  matches('Dashboard', await createLearningxReads(reader).dashboard!({ userId: 'synthetic' }, { detail: 'overview' }));
  const dashboard = createCombinedDashboard({ timetable: async () => ({ term: '2026년 2학기', entries: [] }) }, reader);
  matches('Dashboard', await dashboard.dashboard!({ userId: 'synthetic' }, { detail: 'overview' }));
});

test('strict submission schemas reject other-owner fields, conflicting modes and excessive files', () => {
  const upload = { fileName: '합성 답안.pdf', contentType: 'application/pdf', sizeBytes: 1024 };
  const input = { submissionType: 'online_upload', expectedAttempt: 1, pledgeAccepted: false, pledgeDigest: null,
    uploadIds: ['00000000-0000-4000-8000-000000000001'] };
  assert.ok(uploadInput.safeParse(upload).success); matches('UploadInput', upload);
  assert.ok(submissionInput.safeParse(input).success); matches('SubmissionInput', input);
  for (const bad of [{ ...input, userId: 'other' }, { ...input, text: 'conflicting content' }, { ...input, uploadIds: [] },
    { ...input, uploadIds: [input.uploadIds[0], input.uploadIds[0]] }, { ...input, uploadIds: Array(6).fill(input.uploadIds[0]) }]) {
    assert.equal(submissionInput.safeParse(bad).success, false);
    assert.equal(validators.get('SubmissionInput')!(bad), false);
  }
  for (const bad of [{ ...upload, userId: 'other' }, { ...upload, fileName: '../answer.pdf' }, { ...upload, sizeBytes: 20971521 }]) {
    assert.equal(uploadInput.safeParse(bad).success, false);
    assert.equal(validators.get('UploadInput')!(bad), false);
  }
});

test('strict actual-video observation schemas reject fabricated speed, seeking and hidden playback', () => {
  const value = { positionSeconds: 10, durationSeconds: 60, playbackRate: 1, paused: false, ended: false, seeking: false, visible: true };
  matches('VideoObservation', value);
  matches('VideoObservation', { ...value, capturedAtMs: 0 });
  matches('VideoObservation', { ...value, capturedAtMs: Number.MAX_SAFE_INTEGER });
  for (const capturedAtMs of [-1, Number.MAX_SAFE_INTEGER + 1, null, '10'])
    assert.equal(validators.get('VideoObservation')!({ ...value, capturedAtMs }), false);
  for (const change of [{ playbackRate: 2 }, { seeking: true }, { visible: false }, { completed: true }, { positionSeconds: -1 }])
    assert.equal(validators.get('VideoObservation')!({ ...value, ...change }), false);
  matches('StartObservation', { ...value, paused: true });
  assert.equal(validators.get('StartObservation')!({ ...value, paused: true, capturedAtMs: 0 }), false);
  assert.equal(validators.get('StartObservation')!(value), false);
});

test('manual timing preparation capability is additive and has one exact value', () => {
  const legacy = { playbackId: '00000000-0000-4000-8000-000000000001', nonce: 'a'.repeat(43),
    heartbeatIntervalMs: 5000, reportIntervalMs: 300000, maxInitialPositionSeconds: 0, state: 'ready' };
  matches('ManualPlayback', legacy);
  matches('ManualPlayback', { ...legacy, observationTiming: 'client_monotonic_v1' });
  for (const observationTiming of ['legacy', 'client_monotonic_v2', null, false])
    assert.equal(validators.get('ManualPlayback')!({ ...legacy, observationTiming }), false);
});

test('real authenticated discovery and me responses validate; custom UI version is bounded', async () => {
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), {
    getSession: async () => ({ tokenHash: 'synthetic', clientId: 'alms-web', csrfToken: 'synthetic-csrf',
      analyticsSessionId: '00000000-0000-4000-8000-000000000003', expiresAt: '2099-01-01T00:00:00Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: null, analyticsId: '00000000-0000-4000-8000-000000000002', analyticsEnabled: true } }),
  } as unknown as Store);
  try {
    const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr' };
    const me = await app.inject({ url: '/v1/me', headers }); assert.equal(me.statusCode, 200); matches('Me', me.json());
    const features = await app.inject({ url: '/v1/features', headers }); assert.equal(features.statusCode, 200); matches('FeatureMap', features.json().features);
    const value = structuredClone((httpSchemas.UxEvent!.examples as any[])[0]);
    value.ui_version = 'new-front-v2.1'; matches('UxEvent', value);
    for (const ui_version of ['', 'a'.repeat(65), 'other UI', 'https://front.example'])
      assert.equal(validators.get('UxEvent')!({ ...value, ui_version }), false);
    assert.equal(validators.get('UxEvent')!({ ...value, client_id: 'untrusted' }), false);
  } finally { await app.close(); }
});
