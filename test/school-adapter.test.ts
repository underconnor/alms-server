import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError, LmsExchangeError, type LearningxClient } from '@alms/ssu-api';
import { createSchoolProvider } from '../src/school-adapter.js';
import type { LearningxReader } from '../src/school-read.js';
import { AppError } from '../src/errors.js';
import { randomBytes } from 'node:crypto';
import { encryptSchoolSession, decryptSchoolSession } from '../src/crypto.js';

const artifact = { sToken: 'synthetic-private-token', sIdno: '90000001' };
const identity = { studentId: artifact.sIdno, displayName: '합성 사용자', department: null, status: null };
const evidence = { reason: 'school_rejection_page',httpStatus: 200,finalOrigin: 'lms',
  iframeCount: 0,scriptCount: 0,formCount: 0,frameCandidateCount: 0,hasSchoolRejectionText: true } as const;

async function failedState(failure: Error) {
  const provider = createSchoolProvider(true, undefined, {
    prepare: async () => {},
    exchange: async () => { throw failure; },verify: async () => identity,
  });
  return (await provider.auth!.verifyCallback(artifact)).schoolSession as { lmsExchange: unknown };
}

test('LMS preparation, raw callback exchange and independent portal verification use the same jar', async () => {
  const steps: string[] = []; let first: unknown;
  const provider = createSchoolProvider(true, undefined, {
    prepare: async (http, options) => { assert.deepEqual(options, {canvasLogin:false}); first = http; steps.push('prepare'); await http.jar.setCookie('xn_sso_uniqid_for_this_login=synthetic; Secure; Path=/', 'https://lms.ssu.ac.kr'); },
    exchange: async (http, input, options) => {
      assert.equal(http, first); assert.equal(input, artifact); assert.equal(options?.tokenFormat, 'api_callback');
      assert.equal(typeof options?.onCanvasFrame, 'function');
      assert.equal(await http.jar.getCookieString('https://lms.ssu.ac.kr'), 'xn_sso_uniqid_for_this_login=synthetic');
      steps.push('lms'); return {} as LearningxClient;
    },
    verify: async (http, input) => { assert.equal(http, first); assert.equal(input, artifact); steps.push('portal'); return identity; },
  });
  const result = await provider.auth!.verifyCallback(artifact);
  assert.deepEqual(steps, ['prepare', 'lms', 'portal']); assert.equal(result.subject, artifact.sIdno);
  assert.deepEqual((result.schoolSession as any).lmsExchange, { status: 'ready' });
  assert.equal(JSON.stringify(result).includes(artifact.sToken), false);
  assert.equal(provider.capabilities.schoolRead, false); assert.equal(provider.capabilities.playback, false);
});

test('failed LMS exchange preserves verified portal login but records only an allowed stage and code', async () => {
  for (const failure of [new LmsExchangeError('authentication_required', 'certificate'), new Error('private-raw-body')]) {
    const provider = createSchoolProvider(true, undefined, {
    prepare: async () => {},
      exchange: async () => { throw failure; }, verify: async () => identity,
    });
    const result = await provider.auth!.verifyCallback(artifact);
    assert.equal((result.schoolSession as any).lmsExchange.status, 'failed');
    assert.doesNotMatch(JSON.stringify(result), /private-raw-body|synthetic-private-token/);
  }
});

test('certificate evidence preserves only allowed structure and drops raw extra fields', async () => {
  const failure = Object.assign(new LmsExchangeError('authentication_required','certificate'), {
    certificateEvidence: { ...evidence,body: 'private-certificate-html',url: 'https://lms.ssu.ac.kr/?private-token',
      cookies: ['private-cookie'],nested: { student: 'private-student' } },
  });
  const result = await failedState(failure);
  assert.deepEqual(result.lmsExchange, {
    status: 'failed',stage: 'certificate',code: 'authentication_required',certificateEvidence: evidence,
  });
  assert.doesNotMatch(JSON.stringify(result),/private-certificate-html|private-token|private-cookie|private-student/);
});

test('malformed or unbounded certificate fields are never persisted as diagnostic evidence', async () => {
  for (const invalid of [
    { reason: 'private-raw-reason' },{ finalOrigin: 'https://lms.ssu.ac.kr/?private-token' },
    { httpStatus: 99 },{ httpStatus: 600 },{ httpStatus: '200' },
    { iframeCount: -1 },{ scriptCount: 10001 },{ formCount: 0.5 },
    { frameCandidateCount: NaN },{ hasSchoolRejectionText: 'private-html' },
  ]) {
    const failure = Object.assign(new LmsExchangeError('authentication_required','certificate'), {
      certificateEvidence: { ...evidence,...invalid },
    });
    assert.deepEqual((await failedState(failure)).lmsExchange, {
      status: 'failed',stage: 'certificate',code: 'authentication_required',
    });
  }
});

test('request failure evidence keeps unknown response fields null and guards runtime stage/code values', async () => {
  const requestEvidence = { reason: 'request_failed',httpStatus: null,finalOrigin: 'unknown',
    iframeCount: null,scriptCount: null,formCount: null,frameCandidateCount: null,hasSchoolRejectionText: null };
  const failure = Object.assign(new LmsExchangeError('upstream_unavailable','certificate'), {
    certificateEvidence: requestEvidence,
  });
  assert.deepEqual((await failedState(failure)).lmsExchange, {
    status: 'failed',stage: 'certificate',code: 'upstream_unavailable',certificateEvidence: requestEvidence,
  });
  Object.assign(failure,{ stage: 'private-html-stage',code: 'private-token-code' });
  assert.deepEqual((await failedState(failure)).lmsExchange, {
    status: 'failed',stage: 'unknown',code: 'unexpected_response',certificateEvidence: requestEvidence,
  });
});

test('Canvas identity mismatch or failed independent portal identity never issues a verified identity', async () => {
  let portalChecks = 0;
  const mismatched = createSchoolProvider(true, undefined, {
    prepare: async () => {},
    exchange: async () => { throw new LmsExchangeError('identity_mismatch', 'bootstrap'); },
    verify: async () => { portalChecks++; return identity; },
  });
  await assert.rejects(mismatched.auth!.verifyCallback(artifact), error => error instanceof AppError && error.code === 'SCHOOL_AUTH_FAILED');
  assert.equal(portalChecks, 0);
  const denied = createSchoolProvider(true, undefined, {
    prepare: async () => {},
    exchange: async () => ({} as LearningxClient), verify: async () => { throw new SchoolError('authentication_required'); },
  });
  await assert.rejects(denied.auth!.verifyCallback(artifact), error => error instanceof AppError && error.code === 'SCHOOL_AUTH_FAILED');
});


test('preparation failure skips certificate exchange and preserves only normalized state after portal verification', async () => {
  const steps: string[] = [];
  const provider = createSchoolProvider(true, undefined, {
    prepare: async () => { steps.push('prepare'); throw new LmsExchangeError('upstream_unavailable', 'preparation', true); },
    exchange: async () => { steps.push('exchange'); throw new Error('must not run'); },
    verify: async () => { steps.push('portal'); return identity; },
  });
  const result = await provider.auth!.verifyCallback(artifact);
  assert.deepEqual(steps, ['prepare', 'portal']);
  assert.deepEqual((result.schoolSession as any).lmsExchange, { status: 'failed', stage: 'preparation', code: 'upstream_unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /certificateEvidence|synthetic-private-token/);
});

const frameEvidence = {
  httpStatus: 200, formCount: 1, iframeCount: 0, inlineScriptCount: 2,
  hasLoginCryption: true, hasCanvasLoginForm: true, learningxTokenPresent: true, canvasSessionCookiePresent: false,
};

test('Canvas frame evidence is allowlisted for both successful and failed exchanges', async () => {
  for (const fails of [false, true]) {
    const raw = { ...frameEvidence, body: 'private-frame-html', url: 'https://canvas.ssu.ac.kr/?private-token',
      cookies: ['private-cookie'], nested: { student: 'private-student' } };
    const provider = createSchoolProvider(true, undefined, {
      prepare: async () => {},
      exchange: async (_http, _input, options) => {
        await options?.onCanvasFrame?.(raw);
        // The captured diagnostic is a validated copy, not the library's mutable response object.
        raw.formCount = 9999;
        if (fails) throw new LmsExchangeError('unexpected_response', 'canvas_form');
        return {} as LearningxClient;
      },
      verify: async () => identity,
    });
    const result = await provider.auth!.verifyCallback(artifact);
    assert.deepEqual((result.schoolSession as any).lmsExchange, {
      ...(fails ? { status: 'failed', stage: 'canvas_form', code: 'unexpected_response' } : { status: 'ready' }),
      canvasFrameEvidence: frameEvidence,
    });
    assert.doesNotMatch(JSON.stringify(result), /private-frame-html|private-token|private-cookie|private-student/);
  }
});

test('invalid Canvas diagnostic fields are omitted without changing the authentication outcome', async () => {
  const invalid = [
    { httpStatus: 99 }, { httpStatus: 600 }, { httpStatus: 200.5 }, { httpStatus: '200' }, { httpStatus: null },
    { formCount: -1 }, { formCount: 10001 }, { formCount: null },
    { iframeCount: 0.5 }, { iframeCount: Infinity }, { iframeCount: undefined },
    { inlineScriptCount: NaN }, { inlineScriptCount: '2' },
    { hasLoginCryption: 'private-script' }, { hasCanvasLoginForm: null },
    { learningxTokenPresent: 'private-token' }, { canvasSessionCookiePresent: 1 },
    { canvasCsrfFieldState: 'synthetic-private-token' }, { canvasCsrfFieldState: null }, { canvasCsrfFieldState: true },
  ];
  for (const patch of invalid) {
    const provider = createSchoolProvider(true, undefined, {
      prepare: async () => {},
      exchange: async (_http, _input, options) => {
        await options?.onCanvasFrame?.({ ...frameEvidence, ...patch } as unknown as typeof frameEvidence);
        return {} as LearningxClient;
      },
      verify: async () => identity,
    });
    const result = await provider.auth!.verifyCallback(artifact);
    assert.deepEqual((result.schoolSession as any).lmsExchange, { status: 'ready' });
  }
});

test('Canvas CSRF diagnostics retain only structural enum values through encrypted storage', async () => {
  const key = randomBytes(32);
  for (const state of ['absent', 'present', 'empty', 'multiple', 'unknown'] as const) {
    const provider = createSchoolProvider(true, undefined, {
      prepare: async () => {},
      exchange: async (_http, _input, options) => {
        const raw = { ...frameEvidence, canvasCsrfFieldState: state, csrfValue: 'synthetic-private-csrf', body: 'synthetic-private-body' };
        await options?.onCanvasFrame?.(raw);
        return {} as LearningxClient;
      },
      verify: async () => identity,
    });
    const result = await provider.auth!.verifyCallback(artifact);
    const encrypted = encryptSchoolSession(result.schoolSession, key, 'owner', 'ssu');
    assert.doesNotMatch(encrypted, /canvasCsrfFieldState|synthetic-private/);
    const decoded = decryptSchoolSession(encrypted, key, 'owner', 'ssu') as any;
    assert.deepEqual(decoded.lmsExchange, { status: 'ready', canvasFrameEvidence: { ...frameEvidence, canvasCsrfFieldState: state } });
    assert.doesNotMatch(JSON.stringify(decoded), /synthetic-private-csrf|synthetic-private-body|csrfValue/);
    assert.equal(provider.capabilities.playback, false);
  }
});

test('Canvas diagnostic evidence is isolated to its login attempt and cannot bypass identity checks', async () => {
  let calls = 0;
  const provider = createSchoolProvider(true, undefined, {
    prepare: async () => {},
    exchange: async (_http, _input, options) => {
      calls++;
      if (calls === 1) await options?.onCanvasFrame?.(frameEvidence);
      if (calls === 3) {
        await options?.onCanvasFrame?.(frameEvidence);
        throw new LmsExchangeError('identity_mismatch', 'bootstrap');
      }
      return {} as LearningxClient;
    },
    verify: async () => identity,
  });
  assert.deepEqual(((await provider.auth!.verifyCallback(artifact)).schoolSession as any).lmsExchange, {
    status: 'ready', canvasFrameEvidence: frameEvidence,
  });
  assert.deepEqual(((await provider.auth!.verifyCallback(artifact)).schoolSession as any).lmsExchange, { status: 'ready' });
  await assert.rejects(provider.auth!.verifyCallback(artifact), error => error instanceof AppError && error.code === 'SCHOOL_AUTH_FAILED');
});

test('Canvas parser reasons retain only the nine enum values through encrypted session serialization', async () => {
  const reasons = ['form_target','form_count','csrf_shape','identity_mismatch','issued_payload_count',
    'issued_payload_format','key_format','decrypt_failed','decoded_value_invalid'] as const;
  const key = randomBytes(32);
  for (const reason of reasons) {
    const failure = Object.assign(new LmsExchangeError('unexpected_response','canvas_form',false,undefined,reason), {
      body: 'synthetic-secret-body', url: 'https://canvas.ssu.ac.kr/?synthetic-secret-token',
      csrf: 'synthetic-secret-csrf', key: 'synthetic-secret-key', issuedPassword: 'synthetic-secret-password',
      cause: new Error('synthetic-secret-crypto-error'),
    });
    const state = await failedState(failure);
    const decoded = decryptSchoolSession(encryptSchoolSession(state, key, 'owner', 'ssu'), key, 'owner', 'ssu') as typeof state;
    assert.deepEqual(decoded.lmsExchange, { status: 'failed', stage: 'canvas_form', code: 'unexpected_response', canvasParseReason: reason });
    assert.doesNotMatch(JSON.stringify(decoded), /synthetic-secret|canvas\.ssu\.ac\.kr|cause/);
  }
});

test('invalid or out-of-stage Canvas reasons are omitted instead of retaining arbitrary diagnostic values', async () => {
  for (const reason of [undefined, null, '', 'synthetic-secret', 1, ['decrypt_failed'], { reason: 'decrypt_failed', body: 'synthetic-secret' }]) {
    const failure = Object.assign(new LmsExchangeError('unexpected_response','canvas_form'), { canvasParseReason: reason });
    assert.deepEqual((await failedState(failure)).lmsExchange, { status: 'failed', stage: 'canvas_form', code: 'unexpected_response' });
  }
  for (const stage of ['certificate','canvas_frame','canvas_submit','bootstrap'] as const) {
    const failure = Object.assign(new LmsExchangeError('unexpected_response',stage), { canvasParseReason: 'decrypt_failed' });
    assert.deepEqual((await failedState(failure)).lmsExchange, { status: 'failed', stage, code: 'unexpected_response' });
  }
  const arbitrary = Object.assign(new Error('synthetic-secret'), { stage: 'canvas_form', code: 'unexpected_response', canvasParseReason: 'decrypt_failed' });
  assert.deepEqual((await failedState(arbitrary)).lmsExchange, { status: 'failed', stage: 'unknown', code: 'unexpected_response' });
});

test('new Canvas reasons cannot soften an identity mismatch or turn LearningX success into native success', async () => {
  let calls = 0, portalChecks = 0;
  const provider = createSchoolProvider(true, undefined, {
    prepare: async () => {},
    exchange: async (_http, _input, options) => {
      calls++;
      await options?.onCanvasFrame?.(frameEvidence);
      if (calls === 1) throw Object.assign(new LmsExchangeError('unexpected_response','canvas_form'), { canvasParseReason: 'decrypt_failed' });
      if (calls === 3) throw Object.assign(new LmsExchangeError('identity_mismatch','canvas_form'), { canvasParseReason: 'identity_mismatch' });
      return {} as LearningxClient;
    },
    verify: async () => { portalChecks++; return identity; },
  });
  assert.deepEqual(((await provider.auth!.verifyCallback(artifact)).schoolSession as any).lmsExchange, {
    status: 'failed', stage: 'canvas_form', code: 'unexpected_response', canvasParseReason: 'decrypt_failed', canvasFrameEvidence: frameEvidence,
  });
  assert.deepEqual(((await provider.auth!.verifyCallback(artifact)).schoolSession as any).lmsExchange, {
    status: 'ready', canvasFrameEvidence: { ...frameEvidence, canvasSessionCookiePresent: false },
  });
  await assert.rejects(provider.auth!.verifyCallback(artifact), error => error instanceof AppError && error.code === 'SCHOOL_AUTH_FAILED');
  assert.equal(portalChecks, 2); assert.equal(provider.capabilities.playback, false);
});


test('the provider passes opt-in selection only to course projection without extra school reads or playback activation', async () => {
  const reads: string[] = [];
  const reader: LearningxReader = {
    catalog: async () => assert.fail('unexpected catalog read'),
    readCourse: async (owner, courseId) => {
      reads.push(`${owner}/${courseId}`);
      return { course: { id: courseId, title: '합성 강좌', professor: null, term: null, sourceUrl: null },
        observedAt: '2020-01-01T00:00:00Z', modules: [{ id: '1', title: '합성 주차', week: 1, items: [{
          id: '20', title: '합성 영상', contentType: 'attendance_item', itemContentType: 'commons', resourceType: 'movie',
          sourceUrl: 'https://private.invalid', activityDetailAvailable: true, published: true, unlockAt: '2000-01-01T00:00:00Z',
        }] }] };
    },
    readActivity: async () => assert.fail('selection must not fetch activity details'),
    readTasks: async () => ({ catalog: { courses: [], term: null, termIds: [] }, groups: [], observedAt: '2020-01-01T00:00:00Z' }),
    readAttendance: async () => assert.fail('unexpected attendance read'),
  };
  const fetcher: typeof fetch = async () => assert.fail('selection must not make an extra school request');
  for (const enabled of [undefined, false, true]) {
    const provider = createSchoolProvider(true, reader, undefined, undefined, fetcher, enabled);
    const course = await provider.course!({ userId: 'owner-a' }, '10') as { weeks: Array<{ activities: Array<{ playbackAvailable: boolean }> }> };
    assert.equal(course.weeks[0]!.activities[0]!.playbackAvailable, enabled === true);
    assert.equal(provider.capabilities.playback, false); // Only the separately wired execution provider can activate playback.
    assert.deepEqual(await provider.tasks!({ userId: 'owner-a' }), { items: [], courses: [] });
  }
  assert.deepEqual(reads, ['owner-a/10', 'owner-a/10', 'owner-a/10']);
  const disabled = createSchoolProvider(false, reader, undefined, undefined, fetcher, true);
  assert.equal(disabled.capabilities.playback, false);
  assert.equal(disabled.course, undefined);
  const { readActivity: _unused, ...withoutDetails } = reader;
  const result = await createSchoolProvider(true, withoutDetails, undefined, undefined, fetcher, true).course!({ userId: 'owner-a' }, '10') as any;
  assert.equal(result.weeks[0].activities[0].playbackAvailable, false);
});
