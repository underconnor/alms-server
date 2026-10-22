import { z } from 'zod';
import { SchoolError } from '@alms/ssu-api';
import { AppError } from './errors.js';
import { featureSupport, type FeatureSupport } from './feature-support.js';

export const assignmentId = z.string().regex(/^[1-9]\d{0,15}$/);
export const assignmentReadQuery = z.object({ refresh: z.literal('1').optional() }).strict();
const courseContext = z.object({ id: assignmentId, title: z.string().min(1).max(10000), term: z.string().max(10000).nullable(),
  termId: assignmentId.nullable(), schoolDefaultTerm: z.boolean().nullable(), ended: z.boolean().nullable() });
export type AssignmentCourseContext = z.infer<typeof courseContext>;
type OwnedCourseContext = { id: string; title: string; term: string | null; termId?: string; schoolDefaultTerm?: boolean; ended?: boolean | null };
export function assignmentCourseContext(course: OwnedCourseContext, expectedId: string): AssignmentCourseContext {
  const parsed = courseContext.safeParse({ id: course.id, title: course.title, term: course.term, termId: course.termId ?? null,
    schoolDefaultTerm: course.schoolDefaultTerm ?? null, ended: course.ended ?? null });
  if (!parsed.success || parsed.data.id !== expectedId) throw new SchoolError('unexpected_response');
  return parsed.data;
}
const text = (max: number) => z.string().max(max);
const instant = z.iso.datetime({ offset: true }).nullable();
const finite = z.number().finite();
const submissionType = z.enum(['discussion_topic', 'online_quiz', 'on_paper', 'none', 'external_tool', 'online_text_entry', 'online_url',
  'online_upload', 'media_recording', 'student_annotation', 'basic_lti_launch', 'unknown']);
const feedback = z.array(z.object({ id: assignmentId, text: text(200_000).nullable(), createdAt: instant })).max(100).nullable();
const valueState = z.enum(['missing', 'null', 'available', 'withheld']);
const attachment = z.object({ id: assignmentId, fileName: text(1024).nullable(), contentType: text(256).nullable(),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), downloadAvailable: z.boolean() });
const submission = z.object({
  workflowState: z.enum(['unsubmitted', 'submitted', 'graded', 'pending_review', 'unknown']),
  attempt: z.number().int().min(0).nullable(), submissionType: submissionType.nullable(), submittedAt: instant, gradedAt: instant,
  late: z.boolean().nullable(), missing: z.boolean().nullable(), excused: z.boolean().nullable(), gradeMatchesCurrentSubmission: z.boolean().nullable(),
  postedAt: instant.optional(), score: finite.nullable().optional(), grade: text(128).refine(value => Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value)).nullable().optional(),
  scoreState: valueState, gradeState: valueState, resultVisibility: z.enum(['available', 'not_posted', 'stale', 'unknown']),
  attachments: z.array(attachment).max(100).nullable(), feedback,
});
const summary = z.object({
  id: assignmentId, courseId: assignmentId, title: text(10000).min(1), dueAt: instant, unlockAt: instant, lockAt: instant,
  published: z.boolean().nullable(), lockedForUser: z.boolean().nullable(), submissionTypes: z.array(submissionType).max(20).nullable(),
  allowedExtensions: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,31}$/)).max(100).nullable(), pointsPossible: finite.min(0).nullable(), allowedAttempts: z.number().int().min(-1).nullable(),
  sourceUrl: text(2048).nullable(), moduleItemId: assignmentId.nullable(), submissionState: z.enum(['missing', 'null', 'available']), submission: submission.nullable(),
});
const detail = summary.extend({ descriptionText: text(200_000).nullable(), lockExplanationText: text(200_000).nullable(),
  course: courseContext.optional(),
  descriptionAttachments: z.array(attachment).max(100), ownSubmittedContent: z.object({ text: text(200_000).nullable(),
    url: text(2048).refine(value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value); } catch { return false; } }).nullable(), }).nullable(),
});
const listing = z.object({ courseId: assignmentId, course: courseContext.optional(), items: z.array(summary).max(1000), complete: z.literal(true) });
export type AssignmentListData = z.infer<typeof listing> & { featureSupport?: { assignments: FeatureSupport } };
export type AssignmentDetailData = z.infer<typeof detail> & { featureSupport?: { assignment_detail: FeatureSupport } };
function invalid(): never { throw new SchoolError('unexpected_response'); }
function validateSummary(value: z.infer<typeof summary>, course: string, expectedId?: string) {
  if (value.courseId !== course || expectedId && value.id !== expectedId
    || (value.submissionState === 'available') !== (value.submission !== null)) invalid();
  if (value.sourceUrl !== null && value.sourceUrl !== `https://canvas.ssu.ac.kr/courses/${course}/assignments/${value.id}`) value.sourceUrl = null;
  const own = value.submission;
  if (!own) return;
  for (const rows of [own.attachments, own.feedback])
    if (rows && new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  const visibility = own.gradeMatchesCurrentSubmission === false ? 'stale' : own.postedAt === null ? 'not_posted'
    : typeof own.postedAt === 'string' && own.gradeMatchesCurrentSubmission === true ? 'available' : 'unknown';
  if (own.resultVisibility !== visibility) invalid();
  for (const field of ['score', 'grade'] as const) {
    const state = own[field === 'score' ? 'scoreState' : 'gradeState'], present = Object.hasOwn(own, field), data = own[field];
    if (state === 'missing' ? present : !present) invalid();
    if (state === 'null' && data !== null || state === 'withheld' && (data !== null || visibility === 'available')
      || state === 'available' && (data == null || visibility !== 'available')) invalid();
  }
}
function boundSize(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new SchoolError('unsupported');
}
export function publicAssignments(input: unknown, courseId: string, ownedCourse?: OwnedCourseContext): AssignmentListData {
  const parsed = listing.safeParse(input); if (!parsed.success) invalid();
  const value = parsed.data;
  if (value.courseId !== courseId || new Set(value.items.map(item => item.id)).size !== value.items.length) invalid();
  if (value.course && value.course.id !== courseId) invalid();
  if (ownedCourse) value.course = assignmentCourseContext(ownedCourse, courseId);
  value.items.forEach(item => { validateSummary(item, courseId); item.submission?.attachments?.forEach(file => { file.downloadAvailable = false; }); });
  const result = { ...value, featureSupport: { assignments: featureSupport(true, 'course', { availability: 'available', reason: null, read: true, write: false }) } };
  boundSize(result); return result;
}
export function publicAssignmentDetail(input: unknown, courseId: string, id: string, ownedCourse?: OwnedCourseContext): AssignmentDetailData {
  const parsed = detail.safeParse(input); if (!parsed.success) invalid();
  const value = parsed.data; validateSummary(value, courseId, id);
  if (value.course && value.course.id !== courseId) invalid();
  if (ownedCourse) value.course = assignmentCourseContext(ownedCourse, courseId);
  if (value.submissionState !== 'available') invalid();
  if (new Set(value.descriptionAttachments.map(file => file.id)).size !== value.descriptionAttachments.length
    || value.ownSubmittedContent !== null && !['submitted', 'graded', 'pending_review'].includes(value.submission!.workflowState)) invalid();
  const result = { ...value, featureSupport: { assignment_detail: featureSupport(true, 'assignment', {
    availability: 'available', reason: null, read: true, write: false }) } };
  boundSize(result); return result;
}
export function awaitAssignmentRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError(503, 'ASSIGNMENTS_UNAVAILABLE', '과제를 불러오지 못했습니다. 다시 시도해 주세요.'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
