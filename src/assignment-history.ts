import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { SchoolError } from '@alms/ssu-api';
import { assignmentId } from './assignments.js';

export const assignmentAttemptKey = z.string().regex(/^[a-f0-9]{64}$/);
const field = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.object({ state: z.enum(['missing', 'null', 'not_applicable']), value: z.null() }),
  z.object({ state: z.literal('available'), value }),
]);
const safeUrl = z.string().max(2048).refine(value => {
  if (value === '') return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\\\x00-\x20\x7f]/.test(value); }
  catch { return false; }
});
const file = z.object({ id: assignmentId, fileName: z.string().max(1024).nullable(), contentType: z.string().max(256).nullable(),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), downloadAvailable: z.boolean() });
const row = z.object({ key: assignmentAttemptKey, attempt: z.number().int().min(0).nullable(), submittedAt: z.iso.datetime({ offset: true }).nullable(),
  workflowState: z.enum(['unsubmitted', 'submitted', 'graded', 'pending_review', 'unknown']),
  submissionType: z.enum(['discussion_topic', 'online_quiz', 'on_paper', 'none', 'external_tool', 'online_text_entry', 'online_url',
    'online_upload', 'media_recording', 'student_annotation', 'basic_lti_launch', 'unknown']).nullable(),
  content: z.object({ text: field(z.string().max(200_000)), url: field(safeUrl) }),
  attachments: z.array(file).max(100).nullable(), isCurrent: z.boolean().nullable(),
});
const history = z.object({ courseId: assignmentId, assignmentId, state: z.enum(['available', 'missing', 'null']),
  coverage: z.literal('school_returned'), observedAt: z.iso.datetime({ offset: true }),
  currentAttempt: z.number().int().min(0).nullable(), items: z.array(row).max(100).nullable() });
export type AssignmentHistoryData = z.infer<typeof history>;
const invalid = (): never => { throw new SchoolError('unexpected_response'); };

/** Dedicated own-history projection. No grade, raw school identity or signed URL leaves this read. */
export function publicAssignmentHistory(input: unknown, courseId: string, id: string): AssignmentHistoryData {
  const parsed = history.safeParse(input); if (!parsed.success) return invalid();
  const value = parsed.data;
  if (value.courseId !== courseId || value.assignmentId !== id || (value.state === 'available') !== (value.items !== null)) invalid();
  const rows = value.items ?? [], attempts = rows.flatMap(item => item.attempt === null ? [] : [item.attempt]);
  if (new Set(rows.map(item => item.key)).size !== rows.length || new Set(attempts).size !== attempts.length
    || rows.filter(item => item.isCurrent === true).length > 1) invalid();
  for (const item of rows) {
    if (item.isCurrent === true && (item.attempt === null || item.attempt <= 0 || item.attempt !== value.currentAttempt)
      || item.attachments && new Set(item.attachments.map(attachment => attachment.id)).size !== item.attachments.length) invalid();
    if (item.attachments?.some(file => file.downloadAvailable) && (item.attempt === null || item.attempt <= 0)) invalid();
    for (const [name, kind] of [['text', 'online_text_entry'], ['url', 'online_url']] as const) {
      const content = item.content[name];
      if (content.state === 'available' && item.submissionType !== kind) invalid();
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new SchoolError('unsupported');
  return value;
}

/** A selected-attempt handle is scoped to this owner, generation and verified school row. */
export function bindAssignmentHistory(input: unknown, courseId: string, id: string, owner: string, generation: string, key: Buffer): AssignmentHistoryData {
  const parsed = history.extend({ items: z.array(row.extend({ key: z.string().regex(/^a_[a-f0-9]{64}$/) })).max(100).nullable() }).safeParse(input);
  if (!parsed.success) return invalid();
  const value = parsed.data;
  return publicAssignmentHistory({ ...value, items: value.items?.map(item => ({ ...item,
    key: assignmentHistoryAttemptHandle(item.key, courseId, id, owner, generation, key) })) ?? null }, courseId, id);
}
export function assignmentHistoryAttemptHandle(schoolKey: string, courseId: string, id: string, owner: string, generation: string, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify(['alms-assignment-attempt', 1, owner, generation, courseId, id, schoolKey])).digest('hex');
}
