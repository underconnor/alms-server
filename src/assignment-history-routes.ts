import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SchoolError } from '@alms/ssu-api';
import { assignmentId, assignmentReadQuery, awaitAssignmentRead } from './assignments.js';
import { assignmentAttemptKey, publicAssignmentHistory } from './assignment-history.js';
import { assignmentFileDisposition, publicAssignmentFile } from './assignment-files.js';
import { AppError, unavailable } from './errors.js';
import { normalizeSchoolReadError } from './school-read.js';
import type { AssignmentReadOptions, SchoolProvider } from './provider.js';
import type { Store } from './store.js';

/** Lazy own-history reads share the existing session, deadline and private-byte response boundaries. */
export async function registerAssignmentHistory(app: FastifyInstance, store: Store, authenticate: (request: FastifyRequest) => Promise<void>, provider: SchoolProvider) {
  const base = '/v1/courses/:id/assignments/:assignmentId/submission-history';
  const params = z.object({ id: assignmentId, assignmentId }).strict();
  const route = { preHandler: authenticate };
  async function read<T>(request: FastifyRequest, reply: FastifyReply, run: (options: AssignmentReadOptions) => Promise<T>, refresh?: boolean): Promise<T> {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
    const validate = async () => {
      const session = await store.getSession(request.session!.tokenHash);
      if (!session || session.user.id !== request.session!.user.id) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    };
    try {
      return await awaitAssignmentRead((async () => {
        await validate(); signal.throwIfAborted();
        const result = await run({ signal, validate, ...(refresh ? { refresh: true } : {}) });
        await validate(); signal.throwIfAborted(); return result;
      })(), signal);
    } catch (error) { if (error instanceof SchoolError) return normalizeSchoolReadError(error); throw error; }
    finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
  }
  app.get(base, route, async (request, reply) => {
    const input = params.parse(request.params), query = assignmentReadQuery.parse(request.query);
    if (!provider.assignmentHistory) throw unavailable('ASSIGNMENTS_UNAVAILABLE');
    const value = await read(request, reply, async options => publicAssignmentHistory(
      await provider.assignmentHistory!({ userId: request.session!.user.id }, input.id, input.assignmentId, options), input.id, input.assignmentId), Boolean(query.refresh));
    return reply.header('cache-control', 'private, no-store').send(value);
  });
  app.get(base + '/:attemptKey/files/:fileId', route, async (request, reply) => {
    const input = params.extend({ attemptKey: assignmentAttemptKey, fileId: assignmentId }).parse(request.params);
    const query = z.object({ download: z.literal('1').optional(), refresh: z.literal('1').optional() }).strict().parse(request.query);
    if (!provider.assignmentHistoryFile) throw unavailable('ASSIGNMENT_FILE_UNAVAILABLE');
    const file = await read(request, reply, async options => {
      const value = await provider.assignmentHistoryFile!({ userId: request.session!.user.id }, input.id, input.assignmentId, input.attemptKey, input.fileId, options);
      if (value.fileId !== input.fileId) throw unavailable('ASSIGNMENT_FILE_UNAVAILABLE');
      return publicAssignmentFile(value, { id: input.fileId, fileName: value.fileName, contentType: value.contentType, sizeBytes: null, downloadAvailable: true });
    }, Boolean(query.refresh));
    return reply.type(file.contentType).header('cache-control', 'private, no-store')
      .header('content-disposition', assignmentFileDisposition(file, query.download === '1'))
      .header('content-length', file.bytes.length).header('accept-ranges', 'none')
      .header('content-security-policy', "default-src 'none'; sandbox").send(file.bytes);
  });
}
