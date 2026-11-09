import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { hashToken, type Store } from '../src/store.js';
import { playbackClientAccept } from '../src/playback-client-contract.js';
import { startConsentInput, publicStartConsent } from '../src/playback-start-consent.js';
import { playbackContinuationHash } from '../src/playback-continuation-routes.js';
import type { SchoolProvider } from '../src/provider.js';
import type { PlaybackStartConsentReceipt } from '../src/playback-start-consent.js';
const token = 'q'.repeat(43),
  headers = {
    cookie: '__Host-alms_session=' + token,
    origin: 'https://lms.flyjung.kr',
    accept: playbackClientAccept,
    'x-csrf-token': 'synthetic-csrf',
  };
function fixture() {
  const owner = randomUUID(),
    key = randomBytes(32),
    generation = randomUUID();
  let writes = 0,
    fail = false,
    active = true;
  const receipts = new Map<string, { hash: string; value: PlaybackStartConsentReceipt }>(),
    revoked = new Set<string>();
  const session = {
    tokenHash: hashToken(token),
    csrfToken: headers['x-csrf-token'],
    clientId: null,
    analyticsSessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    user: { id: owner, displayName: '합성 사용자', analyticsId: randomUUID(), analyticsEnabled: false },
  };
  const store = {
    getSession: async () => (active ? session : null),
    getEncryptedSchoolSession: async () =>
      encryptSchoolSession({ version: 1, generation, lmsExchange: { status: 'ready' } }, key, owner, 'ssu'),
    findPlaybackStartConsent: async (_o: string, k: string, _a: unknown, _op: unknown, hash?: string) => {
      const v = receipts.get(k);
      if (v && hash && v.hash !== hash) {
        const { AppError } = await import('../src/errors.js');
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'fixed');
      }
      return v?.value ?? null;
    },
    createPlaybackStartConsent: async (o: string, input: any, k: string, hash: string, auth: any) => {
      assert.equal(o, owner);
      assert.equal(auth.generation, generation);
      assert.equal(auth.clientId, null);
      assert.equal(auth.csrfToken, session.csrfToken);
      writes++;
      const value = {
        id: randomUUID(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        courseId: input.courseId,
        lectureIds: input.lectureIds,
      };
      receipts.set(k, { hash, value });
      if (fail) throw new Error('synthetic commit response loss');
      return value;
    },
    revokePlaybackStartConsent: async (_o: string, id: string) => {
      revoked.add(id);
    },
    getJobRequest: async () => null,
  } as unknown as Store;
  const provider: SchoolProvider = {
    capabilities: { schoolAuthentication: true, schoolRead: false, playback: true, pauseResume: false },
  };
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    SESSION_ENCRYPTION_KEY: key.toString('base64'),
  });
  return {
    store,
    provider,
    receipts,
    revoked,
    owner,
    key,
    app: () => buildApp(config, store, provider, undefined, undefined, { isReady: async () => true }),
    fail: () => {
      fail = true;
    },
    logout: () => {
      active = false;
    },
    writes: () => writes,
  };
}
test('start manifest is canonical, unique, exact and bounded without permissive ID repair', () => {
  assert.deepEqual(
    startConsentInput.parse({ courseId: '10', lectureIds: ['20', '2', '100'], confirmed: true }).lectureIds,
    ['2', '20', '100'],
  );
  for (const v of [[], ['2', '2'], ['02'], ['0'], ['+2'], ['2 '], Array.from({ length: 101 }, (_, i) => String(i + 1))])
    assert.equal(startConsentInput.safeParse({ courseId: '10', lectureIds: v, confirmed: true }).success, false);
  assert.equal(startConsentInput.safeParse({ courseId: '10', lectureIds: ['2'], confirmed: false }).success, false);
  assert.equal(
    startConsentInput.safeParse({ courseId: '10', lectureIds: ['2'], confirmed: true, userId: 'foreign' }).success,
    false,
  );
});
test('consent HTTP records one exact canonical manifest and same-key replay/GET remain available without school API', async () => {
  const f = fixture(),
    app = await f.app(),
    requestKey = randomUUID(),
    h = { ...headers, 'idempotency-key': requestKey };
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/playback-start-consents',
      headers: h,
      payload: { courseId: '10', lectureIds: ['20', '2'], confirmed: true },
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(first.json().lectureIds, ['2', '20']);
    f.provider.capabilities.playback = false;
    const again = await app.inject({
      method: 'POST',
      url: '/v1/playback-start-consents',
      headers: h,
      payload: { courseId: '10', lectureIds: ['2', '20'], confirmed: true },
    });
    assert.equal(again.statusCode, 201);
    assert.equal(again.json().id, first.json().id);
    assert.equal(f.writes(), 1);
    const read = await app.inject({
      method: 'GET',
      url: '/v1/playback-start-consents/requests/' + requestKey,
      headers,
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), first.json());
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/playback-start-consents',
      headers: h,
      payload: { courseId: '10', lectureIds: ['3'], confirmed: true },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await app.close();
  }
});
test('lost consent acceptance is inspectable by exact request key without inventing permission or a new key', async () => {
  const f = fixture(),
    app = await f.app(),
    k = randomUUID();
  f.fail();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/playback-start-consents',
      headers: { ...headers, 'idempotency-key': k },
      payload: { courseId: '10', lectureIds: ['20'], confirmed: true },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'PLAYBACK_START_CONSENT_UNCONFIRMED');
    const read = await app.inject({ method: 'GET', url: '/v1/playback-start-consents/requests/' + k, headers });
    assert.equal(read.statusCode, 200);
    assert.equal(f.writes(), 1);
    assert.deepEqual(read.json().lectureIds, ['20']);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/playback-start-consents/requests/' + randomUUID(), headers }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
test('consent mutations retain CSRF, Origin, registered client, playback Accept and strict input checks', async () => {
  for (const mode of ['csrf', 'origin', 'client', 'accept', 'duplicates', 'extra'] as const) {
    const f = fixture(),
      app = await f.app(),
      h: Record<string, string> = { ...headers, 'idempotency-key': randomUUID() };
    if (mode === 'csrf') h['x-csrf-token'] = 'wrong';
    if (mode === 'origin') h.origin = 'https://foreign.invalid';
    if (mode === 'client') h['x-alms-client-id'] = 'unknown';
    if (mode === 'accept') h.accept = 'application/json';
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/playback-start-consents',
        headers: h,
        payload: {
          courseId: '10',
          lectureIds: mode === 'duplicates' ? ['2', '2'] : ['2'],
          confirmed: true,
          ...(mode === 'extra' ? { generation: randomUUID() } : {}),
        },
      });
      assert.equal(
        response.statusCode,
        { csrf: 403, origin: 403, client: 401, accept: 409, duplicates: 400, extra: 400 }[mode],
        mode + ':' + response.body,
      );
      assert.equal(f.writes(), 0);
    } finally {
      await app.close();
    }
  }
});
test('revocation is explicit, receipt lookup is owner-session protected and no consent is inferred from job absence', async () => {
  const f = fixture(),
    app = await f.app();
  try {
    const id = randomUUID();
    assert.equal(
      (await app.inject({ method: 'DELETE', url: '/v1/playback-start-consents/' + id, headers })).statusCode,
      204,
    );
    assert.ok(f.revoked.has(id));
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/jobs/requests/' + randomUUID(), headers })).statusCode,
      404,
    );
    f.logout();
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/playback-start-consents/requests/' + randomUUID(), headers }))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test('continuation hash preserves legacy body while exact consent changes the new request identity', () => {
  const id = randomUUID(),
    consent = randomUUID();
  assert.equal(
    playbackContinuationHash(id),
    hashToken(JSON.stringify({ operation: 'continue_playback', originalJobId: id })),
  );
  assert.notEqual(playbackContinuationHash(id), playbackContinuationHash(id, consent));
  assert.equal(
    publicStartConsent({ id: consent, expiresAt: new Date().toISOString(), attempt: 'acknowledged' })?.attempt,
    'acknowledged',
  );
  assert.equal(
    publicStartConsent({ id: consent, expiresAt: new Date().toISOString(), attempt: 'acknowledged', token: 'private' }),
    null,
  );
});
test('normal explicit admission passes the exact consent binding and existing fresh authority independently', async () => {
  const f = fixture(),
    consentId = randomUUID(),
    now = new Date().toISOString(),
    jobId = randomUUID();
  let written = 0;
  const { createPlaybackAdmission } = await import('../src/playback-authority.js');
  f.provider.authorizePlayback = async (context, target) =>
    createPlaybackAdmission(
      { ...context, ...target },
      { generation: randomUUID(), encryptedSession: 'synthetic-native-proof' },
    );
  f.store.findJobRequest = async () => null;
  f.store.createJob = async (owner, input, auth) => {
    assert.equal(owner, f.owner);
    assert.equal(input.startConsentId, consentId);
    assert.equal(auth.csrfToken, headers['x-csrf-token']);
    assert.equal(auth.clientId, null);
    written++;
    return {
      id: jobId,
      userId: owner,
      ...input,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      schoolResult: null,
      errorCode: null,
      acceptedGeneration: randomUUID(),
      executionTokenHash: null,
      executionOutcome: null,
      startConsent: { id: consentId, expiresAt: new Date(Date.now() + 10000).toISOString(), attempt: 'not_attempted' },
    };
  };
  const app = await f.app();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { courseId: '10', lectureId: '20', startConsentId: consentId },
    });
    assert.equal(r.statusCode, 202, r.body);
    assert.equal(r.json().startConsent.id, consentId);
    assert.equal(written, 1);
  } finally {
    await app.close();
  }
});
