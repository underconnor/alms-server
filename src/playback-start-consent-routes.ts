import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, notFound, unavailable } from './errors.js';
import type { Store } from './store.js';
import { hashToken } from './store.js';
import { publicJob } from './domain.js';
import type { SchoolProvider } from './provider.js';
import { startConsentInput, inspectConsentSchoolSession } from './playback-start-consent.js';
import { requirePlaybackClient } from './playback-client-contract.js';
import { playbackIsReady, type PlaybackReadinessReader } from './playback-worker-readiness.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';
const empty = z.object({}).strict();
const auth = (r: FastifyRequest) => ({
  almsTokenHash: r.session!.tokenHash,
  csrfToken: r.session!.csrfToken,
  clientId: r.session!.clientId ?? null,
});
const unknown = () =>
  new AppError(
    503,
    'PLAYBACK_START_CONSENT_UNCONFIRMED',
    '동의 요청 결과를 확인해 주세요. 새 요청으로 반복하지 않았어요.',
  );
export function registerPlaybackStartConsents(
  app: FastifyInstance,
  store: Store,
  provider: SchoolProvider,
  authenticate: (r: FastifyRequest) => Promise<void>,
  key: Buffer | undefined,
  readiness?: PlaybackReadinessReader,
) {
  const protectedRoute = {
    preHandler: async (r: FastifyRequest) => boundedWorkerOperation(() => authenticate(r), { timeoutMs: 5000 }),
  };
  app.get('/v1/playback-start-consents/requests/:key', protectedRoute, async (r) => {
    empty.parse(r.query);
    const { key: requestKey } = z.object({ key: z.uuid() }).strict().parse(r.params);
    requirePlaybackClient(r, true);
    if (!store.findPlaybackStartConsent) throw unavailable('PLAYBACK_START_CONSENT_UNAVAILABLE');
    const result = await store.findPlaybackStartConsent(r.session!.user.id, requestKey, auth(r), { timeoutMs: 5000 });
    if (!result) throw notFound();
    return result;
  });
  app.get('/v1/jobs/requests/:key', protectedRoute, async (r) => {
    const query = z.object({ startConsentId: z.uuid().optional() }).strict().parse(r.query);
    const { key: requestKey } = z.object({ key: z.uuid() }).strict().parse(r.params);
    requirePlaybackClient(r, true);
    if (!store.getJobRequest) throw unavailable('PLAYBACK_START_CONSENT_UNAVAILABLE');
    const job = await store.getJobRequest(
      r.session!.user.id,
      requestKey,
      auth(r),
      { timeoutMs: 5000 },
      { ...query, encryptionKey: key },
    );
    if (!job) throw notFound();
    if ('requestStatus' in job) {
      if (!query.startConsentId || job.requestKey !== requestKey || job.startConsentId !== query.startConsentId)
        throw new AppError(502, 'PLAYBACK_REQUEST_INSPECTION_INVALID', '접수 상태를 다시 확인해 주세요.');
      return { requestStatus: 'not_admitted' as const, requestKey, startConsentId: query.startConsentId };
    }
    return publicJob(job);
  });
  app.post('/v1/playback-start-consents', protectedRoute, async (r, reply) => {
    empty.parse(r.query);
    const input = startConsentInput.parse(r.body),
      requestKey = z.uuid().parse(r.headers['idempotency-key']);
    requirePlaybackClient(r, true);
    if (!store.findPlaybackStartConsent || !store.createPlaybackStartConsent || !key)
      throw unavailable('PLAYBACK_START_CONSENT_UNAVAILABLE');
    const owner = r.session!.user.id,
      authorization = auth(r),
      requestHash = hashToken(JSON.stringify(input));
    let writing = false;
    const controller = new AbortController(),
      abort = () => controller.abort();
    r.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const result = await boundedWorkerOperation(
        async (signal) => {
          const op = { signal, timeoutMs: 5000 };
          const existing = await store.findPlaybackStartConsent!(owner, requestKey, authorization, op, requestHash);
          if (existing) return existing;
          if (!provider.capabilities.playback || !(await playbackIsReady(readiness, signal)))
            throw unavailable('PLAYBACK_UNAVAILABLE');
          const raw = await store.getEncryptedSchoolSession(owner, 'ssu');
          signal.throwIfAborted();
          const school = inspectConsentSchoolSession(raw, key, owner);
          writing = true;
          return store.createPlaybackStartConsent!(
            owner,
            input,
            requestKey,
            requestHash,
            { ...authorization, ...school },
            op,
          );
        },
        { signal: controller.signal, timeoutMs: 15000 },
      );
      return reply.code(201).send(result);
    } catch (error) {
      if (
        controller.signal.aborted ||
        error instanceof WorkerDeadlineError ||
        (writing && !(error instanceof AppError))
      )
        throw unknown();
      throw error;
    } finally {
      r.raw.off('aborted', abort);
      reply.raw.off('close', abort);
    }
  });
  app.delete('/v1/playback-start-consents/:id', protectedRoute, async (r, reply) => {
    empty.parse(r.query);
    if (r.body !== undefined) empty.parse(r.body);
    requirePlaybackClient(r, true);
    const { id } = z.object({ id: z.uuid() }).strict().parse(r.params);
    if (!store.revokePlaybackStartConsent) throw unavailable('PLAYBACK_START_CONSENT_UNAVAILABLE');
    await store.revokePlaybackStartConsent(r.session!.user.id, id, auth(r), { timeoutMs: 5000 });
    return reply.code(204).send();
  });
}
