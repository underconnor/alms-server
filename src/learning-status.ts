import { z } from 'zod';
import { SchoolError } from '@alms/ssu-api';
import type { SchoolResult } from './domain.js';

const id = z.string().regex(/^[1-9]\d{0,15}$/);
const amount = z.number().finite().min(0).nullable();
export const learningEvidence = z.object({
  resourceType: z.enum(['movie', 'readystream', 'pdf', 'file']), published: z.boolean().nullable(), opened: z.boolean().nullable(),
  useAttendance: z.boolean().nullable(), omitProgress: z.boolean().nullable(), completed: z.boolean().nullable(),
  schoolAttendanceStatus: z.enum(['attendance', 'absent', 'late', 'none', 'unknown']).nullable(),
  progressSeconds: amount, lastPositionSeconds: amount, durationSeconds: amount,
});
const schoolStatus = learningEvidence.extend({ courseId: id, moduleItemId: id, itemId: id,
  observedAt: z.iso.datetime({ offset: true }), progressPercent: z.number().min(0).max(100).nullable(),
  attendance: z.enum(['not_applicable', 'unknown']), recognized: z.null() });
export type LearningEvidence = z.infer<typeof learningEvidence>;
export function learningEvidenceMatches(value: LearningEvidence, progressPercent: number | null, attendance: string) {
  const percent = ['movie', 'readystream'].includes(value.resourceType) && value.durationSeconds !== null && value.durationSeconds > 0 && value.progressSeconds !== null
    ? Math.min(100, value.progressSeconds / value.durationSeconds * 100) : null;
  return progressPercent === percent && attendance === (value.useAttendance === false ? 'not_applicable' : 'unknown')
    && (['movie', 'readystream'].includes(value.resourceType) || [value.durationSeconds, value.progressSeconds, value.lastPositionSeconds].every(value => value === null));
}
export function projectLearningStatus(input: unknown, courseId: string, moduleItemId: string): SchoolResult {
  const parsed = schoolStatus.safeParse(input);
  if (!parsed.success) throw new SchoolError('unexpected_response');
  const value = parsed.data;
  if (value.courseId !== courseId || value.moduleItemId !== moduleItemId) throw new SchoolError('forbidden_target');
  if (!learningEvidenceMatches(value, value.progressPercent, value.attendance))
    throw new SchoolError('unexpected_response');
  return { observedAt: value.observedAt, progressPercent: value.progressPercent, attendance: value.attendance,
    recognized: null, evidence: learningEvidence.parse(value) };
}
