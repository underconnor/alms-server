import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { AppError, notFound, unavailable } from './errors.js';
import type { Store } from './store.js';
import type { SchoolProvider } from './provider.js';

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const target = z.object({ id: identifier, activityId: identifier });
const patch = z.object({ completed: z.boolean() }).strict();
const course = z.object({
  course: z.object({ id: identifier }).passthrough(),
  weeks: z.array(z.object({ activities: z.array(z.object({
    id: identifier, courseId: identifier, published: z.boolean().nullable().optional(),
  }).passthrough()) }).passthrough()),
}).passthrough();
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Personal planning state stays separate from all school observations and writes. */
export function registerPersonalCompletion(app: FastifyInstance, store: Store, provider: SchoolProvider,
  authenticate: (request: FastifyRequest) => Promise<void>) {
  const validate = async (request: FastifyRequest) => {
    const expected = request.session!, current = await store.getSession(expected.tokenHash);
    if (!current || current.user.id !== expected.user.id || !equal(current.csrfToken, expected.csrfToken))
      throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
  };
  app.get('/v1/courses/:id/completions', { preHandler: authenticate }, async request => {
    z.object({}).strict().parse(request.query);
    const courseId = identifier.parse((request.params as { id: string }).id);
    const items = await store.listCompletions(request.session!.user.id, courseId);
    await validate(request);
    return { items };
  });
  for (const method of ['PATCH', 'DELETE'] as const) {
    app.route({ method, url: '/v1/courses/:id/activities/:activityId/completion', preHandler: authenticate,
      handler: async (request, reply) => {
        z.object({}).strict().parse(request.query);
        const { id: courseId, activityId } = target.parse(request.params);
        const input = method === 'PATCH' ? patch.parse(request.body) : (z.undefined().parse(request.body), null);
        if (!provider.course) throw unavailable('COURSE_UNAVAILABLE');
        await validate(request);
        // provider.course is an ownership-checked public DTO, including past terms.
        // A submitted assignment id is not a module activity id.
        const read = course.safeParse(await provider.course({ userId: request.session!.user.id }, courseId));
        if (!read.success || read.data.course.id !== courseId) throw unavailable('COURSE_UNAVAILABLE');
        const matches = read.data.weeks.flatMap(week => week.activities).filter(item => item.id === activityId);
        // Some visible assignment modules omit publication metadata. Personal
        // planning accepts that owner-checked module, but never explicit false.
        if (matches.length !== 1 || matches[0]!.courseId !== courseId || matches[0]!.published === false) throw notFound();
        await validate(request);
        const session = request.session!, authorization = { tokenHash: session.tokenHash, csrfToken: session.csrfToken };
        if (input) return store.setCompletion(session.user.id, courseId, activityId, input.completed, authorization);
        await store.deleteCompletion(session.user.id, courseId, activityId, authorization);
        return reply.code(204).send();
      },
    });
  }
}
