import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, unavailable } from './errors.js';
import type { Store } from './store.js';
import type { SchoolProvider } from './provider.js';
import { publicVerifiedSchoolResult, waitForVerification } from './job-verification.js';

const target = z.object({ id: z.string().regex(/^[1-9]\d{0,15}$/), activityId: z.string().regex(/^[1-9]\d{0,15}$/) });

/** Explicit fresh school read. It neither requires a playback job nor changes learning/job records. */
export function registerActivityLearningStatus(app: FastifyInstance, store: Store, provider: SchoolProvider,
  authenticate: (request: FastifyRequest) => Promise<void>) {
  const active = new Set<string>(), limits = new Map<string, { startsAt: number; count: number }>();
  const contexts = new WeakMap<FastifyRequest, { signal: AbortSignal; clean: () => void }>();
  const cleanup = (request: FastifyRequest) => { contexts.get(request)?.clean(); contexts.delete(request); };
  const databaseRead = <T>(pending: Promise<T>, signal: AbortSignal) =>
    waitForVerification(pending, AbortSignal.any([signal, AbortSignal.timeout(5_000)]));

  app.get('/v1/courses/:id/activities/:activityId/learning-status', {
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
    const { id: courseId, activityId } = target.parse(request.params);
    z.object({}).strict().parse(request.query);
    const userId = request.session!.user.id, token = request.session!.tokenHash;
    const validate = async () => {
      const current = await databaseRead(store.getSession(token), signal);
      if (!current || current.user.id !== userId) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      signal.throwIfAborted();
    };
    const run = async () => {
      await validate();
      if (!provider.learningStatus) throw unavailable('SCHOOL_RESULT_UNAVAILABLE');
      if (active.has(userId)) throw new AppError(409, 'LEARNING_STATUS_BUSY', '학교 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.');
      const now = Date.now();
      for (const [key, value] of limits) if (value.startsAt + 60_000 <= now) limits.delete(key);
      const limit = limits.get(userId) ?? { startsAt: now, count: 0 };
      if (limit.count >= 12 || !limits.has(userId) && limits.size >= 500)
        throw new AppError(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.');
      limit.count++; limits.set(userId, limit); active.add(userId);
      try {
        signal.throwIfAborted();
        // The provider binds the requested module item to current school identity, ownership and generation.
        const target = { courseId, lectureId: activityId };
        const raw = await waitForVerification(provider.learningStatus({ userId }, target, signal), signal);
        const schoolResult = publicVerifiedSchoolResult(raw);
        await validate();
        if (provider.refreshLearningStatus) {
          await waitForVerification(provider.refreshLearningStatus({ userId }, target, raw, { signal, validate }), signal);
        }
        signal.throwIfAborted();
        return { courseId, activityId, schoolResult, stateChanged: false as const };
      } finally { active.delete(userId); }
    };
    return waitForVerification(run(), signal);
  });
}
