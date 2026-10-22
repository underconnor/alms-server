import type { FastifyReply, FastifyRequest } from 'fastify';
import { manualVideoObservationFailureKind } from './manual-video-observation-diagnostics.js';

type Role = 'prepare' | 'observation' | 'report' | 'stop';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function logManualObservationFailure(request: FastifyRequest, error: unknown) {
  const traceId = request.headers['x-alms-trace-id'];
  if (typeof traceId !== 'string' || !uuidV4.test(traceId)) return;
  const kind = manualVideoObservationFailureKind(error);
  if (!kind) return;
  try { request.log.info({ event: 'manual_observation_rejected', traceId, kind }, 'manual observation rejected'); }
  catch { /* A diagnostic cannot alter the original failure or trigger a replay. */ }
}

/** The service has validated this result; an HTTP 200 alone is not this evidence. */
export function logManualReportResult(request: FastifyRequest,
  event: 'playing' | 'update' | 'unload' | 'ended',
  result: { report: 'acknowledged' | 'unknown'; state: 'ready' | 'closed' }) {
  const traceId = request.headers['x-alms-trace-id'];
  if (typeof traceId !== 'string' || !uuidV4.test(traceId)) return;
  try { request.log.info({ event: 'manual_report_result', traceId, reportEvent: event,
    report: result.report, state: result.state }, 'manual report result'); }
  catch { /* Logging cannot alter an accepted report or trigger a replay. */ }
}

/** Optional transport correlation, never authentication or a school playback identifier. */
export function manualTransportTrace(role: Role) {
  const pending = new WeakMap<FastifyRequest, { id: string; start: number; close: () => void }>();
  const log = (request: FastifyRequest, stage: 'received' | 'completed' | 'closed_before_finish',
    traceId: string, elapsedMs: number, statusCode: number | null) => {
    try { request.log.info({ event: 'manual_transport', traceId, role, stage,
      elapsedMs: Math.max(0, Math.round(elapsedMs * 100) / 100), statusCode }, 'manual transport'); }
    catch { /* Diagnostics must not change the original request. */ }
  };
  return {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      const id = request.headers['x-alms-trace-id'];
      if (typeof id !== 'string' || !uuidV4.test(id)) return;
      const start = performance.now();
      const close = () => {
        if (reply.raw.writableFinished) return;
        pending.delete(request);
        log(request, 'closed_before_finish', id, performance.now() - start, null);
      };
      pending.set(request, { id, start, close });
      reply.raw.once('close', close);
      log(request, 'received', id, 0, null);
    },
    onResponse: async (request: FastifyRequest, reply: FastifyReply) => {
      const trace = pending.get(request);
      if (!trace) return;
      pending.delete(request);
      reply.raw.off('close', trace.close);
      log(request, 'completed', trace.id, performance.now() - trace.start, reply.statusCode);
    },
  };
}
