import { requirePlaybackClient } from './playback-client-contract.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, notFound, unavailable } from './errors.js';
import { publicJob, type Job } from './domain.js';
import type { SchoolProvider } from './provider.js';
import type { Store } from './store.js';
import { learningEvidence, learningEvidenceMatches } from './learning-status.js';

const resultSchema = z.object({ observedAt: z.iso.datetime({ offset: true }), progressPercent: z.number().min(0).max(100).nullable(),
  attendance: z.enum(['not_applicable', 'unknown']), recognized: z.null(), evidence: learningEvidence.optional() });
export function publicVerifiedSchoolResult(value: unknown) {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success || parsed.data.evidence && !learningEvidenceMatches(parsed.data.evidence, parsed.data.progressPercent, parsed.data.attendance))
    throw new AppError(502, 'SCHOOL_RESULT_INVALID', '학교 결과를 확인하지 못했습니다. 다시 조회해 주세요.');
  return parsed.data;
}
export function waitForVerification<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '학교 결과 조회가 중단됐습니다. 다시 시도해 주세요.'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const sameJob = (initial: Job, current: Job) => ['id', 'userId', 'courseId', 'lectureId', 'status', 'createdAt', 'updatedAt']
  .every(key => initial[key as keyof Job] === current[key as keyof Job]);
const databaseRead = <T>(pending: Promise<T>, signal: AbortSignal) =>
  waitForVerification(pending, AbortSignal.any([signal, AbortSignal.timeout(5_000)]));

/** Read-only job inspection: no job/result write, state transition, playback, report or retry. */
export function registerJobVerification(app: FastifyInstance, store: Store, provider: SchoolProvider,
  authenticate: (request: FastifyRequest) => Promise<void>) {
  const active = new Set<string>(), limits = new Map<string, { startsAt: number; count: number }>();
  const contexts = new WeakMap<FastifyRequest, { signal: AbortSignal; clean: () => void }>();
  const cleanup = (request: FastifyRequest) => { contexts.get(request)?.clean(); contexts.delete(request); };
  app.get('/v1/jobs/:id/verify', {
    onRequest: async (request, reply) => {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
      const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
      contexts.set(request, { signal, clean: () => { request.raw.off('aborted', abort); reply.raw.off('close', abort); } });
    },
    preHandler: async request => { await databaseRead(authenticate(request), contexts.get(request)!.signal); },
    onResponse: async request => cleanup(request),
    onError: async request => cleanup(request),
  }, async request => {
    const signal = contexts.get(request)!.signal;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.query);
    const owner = request.session!.user.id, token = request.session!.tokenHash;
    const validate = async () => {
      const current = await databaseRead(store.getSession(token), signal);
      if (!current || current.user.id !== owner) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      signal.throwIfAborted();
    };
    const run = async () => {
      await validate();
      const value = await databaseRead(store.getJob(owner, id), signal);
      if (!value || value.userId !== owner || value.id !== id) throw notFound();
      requirePlaybackClient(request, provider.capabilities.playback || value.acceptedGeneration != null);
      const initial = structuredClone(value);
      if (!/^[1-9]\d{0,15}$/.test(initial.courseId) || !/^[1-9]\d{0,15}$/.test(initial.lectureId)) throw unavailable('SCHOOL_RESULT_UNAVAILABLE');
      if (!provider.learningStatus) throw unavailable('SCHOOL_RESULT_UNAVAILABLE');
      if (active.has(owner)) throw new AppError(409, 'JOB_VERIFICATION_BUSY', '학교 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.');
      const now = Date.now(); for (const [key, value] of limits) if (value.startsAt + 60_000 <= now) limits.delete(key);
      const limit = limits.get(owner) ?? { startsAt: now, count: 0 };
      if (limit.count >= 12 || !limits.has(owner) && limits.size >= 500) throw new AppError(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.');
      limit.count++; limits.set(owner, limit); active.add(owner);
      try {
        signal.throwIfAborted();
        const target = { courseId: initial.courseId, lectureId: initial.lectureId };
        const raw = await waitForVerification(provider.learningStatus({ userId: owner }, target, signal), signal);
        const schoolResult = publicVerifiedSchoolResult(raw);
        await validate();
        let current = await databaseRead(store.getJob(owner, id), signal);
        if (!current || !sameJob(initial, current)) throw new AppError(409, 'JOB_CHANGED', '작업 상태가 바뀌었습니다. 다시 조회해 주세요.');
        await validate();
        // The final authorization read can overlap cancellation/recovery; compare once more after it.
        current = await databaseRead(store.getJob(owner, id), signal);
        if (!current || !sameJob(initial, current)) throw new AppError(409, 'JOB_CHANGED', '작업 상태가 바뀌었습니다. 다시 조회해 주세요.');
        if (provider.refreshLearningStatus) {
          const validateRefresh = async () => {
            await validate();
            current = await databaseRead(store.getJob(owner, id), signal);
            if (!current || !sameJob(initial, current)) throw new AppError(409, 'JOB_CHANGED', '작업 상태가 바뀌었습니다. 다시 조회해 주세요.');
          };
          await waitForVerification(provider.refreshLearningStatus({ userId: owner }, target, raw, { signal, validate: validateRefresh }), signal);
        }
        signal.throwIfAborted();
        return { job: publicJob(current), schoolResult, stateChanged: false as const };
      } finally { active.delete(owner); }
    };
    return waitForVerification(run(), signal);
  });
}
