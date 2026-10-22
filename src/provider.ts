import type { PlaybackTerminationProof } from './playback-termination.js';
import { unavailable } from './errors.js';
import type { Job, SchoolResult } from './domain.js';
import type { VideoRequest, VideoResponse } from './video-stream.js';
import type { CalendarQuery, CalendarData } from './calendar.js';
import type { AssignmentListData, AssignmentDetailData } from './assignments.js';
import type { AssignmentFileData } from './assignment-files.js';
import type { AssignmentHistoryData } from './assignment-history.js';
import { jobClaim, type PlaybackAdmission, type PlaybackFinalProof, type WorkerClaim } from './playback-authority.js';

export interface SchoolContext { userId: string }
export interface PlaybackContext extends SchoolContext { claim: WorkerClaim }
export interface SyllabusReadOptions { refresh?: boolean; signal: AbortSignal; validate: () => Promise<void> }
export interface AssignmentReadOptions { refresh?: boolean; signal: AbortSignal; validate: () => Promise<void> }
export interface CalendarReadOptions { refresh?: boolean; signal: AbortSignal; validate: () => Promise<void>;
  // Internal owner-scoped DB callback; only these calendar assignment courses may need cold module reads.
  personalCompletionCourses?: (courseIds: readonly string[]) => Promise<readonly string[]> }
export interface TasksReadOptions { signal?: AbortSignal; validate?: () => Promise<void>;
  personalCompletionCourses?: (courseIds: readonly string[]) => Promise<readonly string[]> }
export interface MaterialReadOptions { refresh?: boolean }
export interface LearningStatusRefreshOptions { signal: AbortSignal; validate: () => Promise<void> }
export interface CourseCatalogOptions { termId?: string }
export interface DashboardReadOptions { detail?: 'overview' }
export interface MaterialViewObservation { event: 'opened' | 'page_changed'; page: number; totalPages: number; viewedPages: number[] }
export interface PlaybackTarget { courseId: string; lectureId: string }
// Server-only ownership token. Its adapter-private contents must never enter DTOs, jobs or logs.
export interface PreparedPlayback {
  readonly alreadyRecognized: boolean;
  readonly handle: object;
  // Idempotent cleanup: resolves only after this job's runtime has actually stopped.
  dispose(): Promise<void>;
  // Optional private evidence; absent for old adapters or any unsettled callback/runtime.
  terminationProof?(): PlaybackTerminationProof | null;
}
export interface VerifiedSchoolIdentity {
  subject: string;
  displayName?: string;
  // Only verified, server-obtained school session state. The adapter controls its schema.
  schoolSession: unknown;
}
export interface SchoolAuthenticator {
  providerId: string;
  createLoginUrl(callbackUrl: string): string | Promise<string>;
  verifyCallback(artifact: { sToken: string; sIdno: string }): Promise<VerifiedSchoolIdentity>;
}
export interface SchoolProvider {
  capabilities: { schoolAuthentication: boolean; schoolRead: boolean; playback: boolean; pauseResume: boolean };
  // The adapter must verify school identity and callback binding before the internal session issuer is called.
  auth?: SchoolAuthenticator;
  dashboard?(context: SchoolContext, options?: DashboardReadOptions): Promise<unknown>;
  courses?(context: SchoolContext, options?: CourseCatalogOptions): Promise<unknown>;
  courseTerms?(context: SchoolContext): Promise<unknown>;
  course?(context: SchoolContext, courseId: string): Promise<unknown>;
  activity?(context: SchoolContext, courseId: string, moduleItemId: string): Promise<unknown>;
  // Called only after an explicit material view. Reads and cache warmups never invoke this.
  recordMaterialView?(context: SchoolContext, courseId: string, moduleItemId: string, observation: MaterialViewObservation, validate: () => Promise<void>): Promise<unknown>;
  material?(context: SchoolContext, courseId: string, moduleItemId: string, options?: MaterialReadOptions): Promise<{ bytes: Buffer }>;
  video?(context: SchoolContext, courseId: string, moduleItemId: string, request: VideoRequest): Promise<VideoResponse>;
  syllabus?(context: SchoolContext, courseId: string, options: SyllabusReadOptions): Promise<unknown>;
  syllabusMaterial?(context: SchoolContext, courseId: string, options: SyllabusReadOptions): Promise<{ bytes: Buffer }>;
  attendance?(context: SchoolContext, courseId?: string): Promise<unknown>;
  timetable?(context: SchoolContext): Promise<unknown>;
  tasks?(context: SchoolContext, options?: TasksReadOptions): Promise<unknown>;
  // Validates this exact object's private proof against one live ALMS/school authority snapshot.
  // Token hash and proof metadata are adapter-private and never enter the public TODO response.
  validateTasks?(context: SchoolContext & { sessionTokenHash: string }, result: unknown): Promise<void>;
  assignments?(context: SchoolContext, courseId: string, options: AssignmentReadOptions): Promise<AssignmentListData>;
  assignment?(context: SchoolContext, courseId: string, assignmentId: string, options: AssignmentReadOptions): Promise<AssignmentDetailData>;
  assignmentFile?(context: SchoolContext, courseId: string, assignmentId: string, fileId: string, options: AssignmentReadOptions): Promise<AssignmentFileData>;
  assignmentHistory?(context: SchoolContext, courseId: string, assignmentId: string, options: AssignmentReadOptions): Promise<AssignmentHistoryData>;
  assignmentHistoryFile?(context: SchoolContext, courseId: string, assignmentId: string, attemptKey: string, fileId: string, options: AssignmentReadOptions): Promise<AssignmentFileData>;
  calendar?(context: SchoolContext, query: CalendarQuery, options: CalendarReadOptions): Promise<CalendarData>;
  validateCalendar?(context: SchoolContext & { sessionTokenHash: string }, result: unknown): Promise<void>;
  // Must check account ownership, actual school availability and prior completion before playback.
  // One fresh handle per job. On rejection, the adapter must clean up any partial preparation.
  authorizePlayback?(context: SchoolContext, target: PlaybackTarget, options: { signal: AbortSignal; validate: () => Promise<void> }): Promise<PlaybackAdmission>;
  preparePlayback?(context: PlaybackContext, target: PlaybackTarget, signal: AbortSignal): Promise<PreparedPlayback>;
  // Resolution means playback ended, never attendance recognition. Abort must stop the real runtime before resolving/rejecting.
  play?(prepared: PreparedPlayback, signal: AbortSignal): Promise<void>;
  // Optional short, abortable ownership/session-generation check; either authentication code requires reauthentication.
  // Its ownership snapshot must stay valid through dispose(), until the runner records its final state.
  validatePlayback?(prepared: PreparedPlayback, signal: AbortSignal): Promise<PlaybackFinalProof>;
  // Same prepared identity/generation/claim, including a bounded read after disposal on cancellation.
  playbackLearningStatus?(prepared: PreparedPlayback, signal: AbortSignal): Promise<SchoolResult>;
  learningStatus?(context: SchoolContext, target: PlaybackTarget, signal?: AbortSignal): Promise<SchoolResult>;
  // Cache-only follow-up to this request's verified read; no school/job record change.
  // Must run options.validate before/after deletion and check the same school generation last.
  refreshLearningStatus?(context: SchoolContext, target: PlaybackTarget, result: SchoolResult, options: LearningStatusRefreshOptions): Promise<void>;
}

export const unavailableSchoolProvider: SchoolProvider = {
  capabilities: { schoolAuthentication: false, schoolRead: false, playback: false, pauseResume: false },
};

export async function readSchool(provider: SchoolProvider, feature: 'dashboard' | 'courses' | 'attendance' | 'timetable' | 'tasks', userId: string) {
  const read = provider[feature];
  if (!read) throw unavailable();
  return read.call(provider, { userId });
}
export function playbackContext(job: Job) {
  return { context: { userId: job.userId, claim: jobClaim(job) }, target: { courseId: job.courseId, lectureId: job.lectureId } };
}
