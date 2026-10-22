import { LearningxClient, type SchoolHttpClient } from '@alms/ssu-api';
import { createLearningxReader } from '../../src/school-reader.js';
import type { SchoolReadCache } from '../../src/school-read-cache.js';

type ReaderStore = Parameters<typeof createLearningxReader>[0];
export function assignmentCatalogFixture(store: ReaderStore, key: Buffer, durable?: SchoolReadCache) {
  const trace: string[] = [];
  const backendSelections: string[][] = [];
  const state = { backendCurrent: true, backendPast: true, sdkCurrent: true, sdkPast: true, sdkExtra: 0, identity: true,
    load: async () => {}, connect: async () => {} };
  const terms = { enrollment_terms: [{ id: '1', name: '2099 Current', default: true }, { id: '2', name: '2098 Past', default: false }] };
  const courses = [{ id: '10', name: 'Synthetic current course', term_id: '1', ended: false },
    { id: '20', name: 'Synthetic past course', term_id: '2', ended: true }];
  const submission = (course: string, assignment: string) => ({ course_id: course, assignment_id: assignment, user_id: '99',
    workflow_state: 'submitted', attempt: 1, submission_type: 'online_text_entry', submitted_at: '2099-10-02T00:00:00Z',
    body: 'Synthetic submitted text', attachments: [], submission_comments: [] });
  const assignment = (course: string, id: string) => ({ id, course_id: course, name: 'Synthetic assignment',
    published: true, submission_types: ['online_text_entry'], submission: submission(course, id), description: 'Synthetic instructions' });
  const reader = () => createLearningxReader(store, key, async session => {
    trace.push('bootstrap'); await state.connect();
    const http = {
      // Generic catalog planning and the SDK's fresh assignment authority use separate methods.
      get: async (raw: string) => {
        const url = new URL(raw); let value: unknown;
        if (url.pathname.endsWith('/terms')) { trace.push('backend_terms'); value = terms; }
        else if (url.pathname.endsWith('/courses')) {
          trace.push('backend_courses'); const ids = url.searchParams.getAll('term_ids[]'); backendSelections.push(ids);
          value = courses.filter(course => ids.includes(course.term_id) && (course.id === '10' ? state.backendCurrent : state.backendPast));
        } else throw new Error('Unexpected synthetic planning request');
        return { body: JSON.stringify(value), contentType: 'application/json' };
      },
      readAssignmentJson: async (raw: string, signal: AbortSignal) => {
        signal.throwIfAborted(); const url = new URL(raw); let value: unknown;
        if (url.pathname === '/api/v1/users/self/profile') {
          trace.push('sdk_self'); value = { id: state.identity ? '99' : '100', login_id: session.identity.studentId };
        } else if (url.pathname.endsWith('/terms')) { trace.push('sdk_terms'); value = terms; }
        else if (url.pathname.endsWith('/learn_activities/courses')) {
          trace.push('sdk_courses'); value = [...courses.filter(course => course.id === '10' ? state.sdkCurrent : state.sdkPast),
            ...Array.from({ length: state.sdkExtra }, (_, index) => ({ id: String(index + 100), name: 'Synthetic other course', term_id: '2' }))];
        } else {
          const match = /^\/api\/v1\/courses\/(10|20)\/assignments(?:\/(90|91)(?:\/submissions\/99)?)?$/.exec(url.pathname);
          if (!match) throw new Error('Unexpected synthetic native request');
          const course = match[1]!, id = match[2] ?? '90'; await state.load(); signal.throwIfAborted();
          if (url.pathname.endsWith('/submissions/99')) {
            trace.push('sdk_submission'); const own = submission(course, id);
            value = url.searchParams.getAll('include[]').includes('submission_history') ? { ...own, submission_history: [own] } : own;
          } else { trace.push(match[2] ? 'sdk_detail' : 'sdk_list'); value = match[2] ? assignment(course, id) : [assignment(course, id)]; }
        }
        return { value, byteLength: Buffer.byteLength(JSON.stringify(value)), link: null };
      },
    } as unknown as SchoolHttpClient;
    return { client: new LearningxClient(http, { userId: '99', userLogin: session.identity.studentId, role: 1,
      moduleBuilderToolId: '3', attendanceToolId: '4' }), serialize: async () => ({}) };
  }, undefined, durable, undefined, null);
  return { reader, trace, backendSelections, state, count: (name: string) => trace.filter(item => item === name).length };
}
