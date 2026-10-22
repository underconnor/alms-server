import type { SchoolProvider } from './provider.js';
import type { SchoolOptions } from './assignment-submission-types.js';
import { limits } from './assignment-submission-types.js';

export type FeatureReason = 'not_implemented' | 'provider_unavailable' | 'requires_school_read' | 'requires_detail'
  | 'course_read_only' | 'not_published' | 'not_opened' | 'unsupported_resource' | 'progress_not_applicable'
  | 'runtime_not_ready' | 'overview_only' | 'school_week_unavailable' | 'source_unavailable'
  | 'conditions_unknown' | 'locked' | 'attempts_exhausted' | 'unsupported_mode' | 'group_submission' | 'submission_in_progress';
export type FeatureScope = 'service' | 'course' | 'module_collection' | 'activity' | 'assignment';
export type SubmissionConstraints = {
  modes: SchoolOptions['modes']; allowedExtensions: string[] | null; expectedAttempt: number | null;
  pledgeRequired: boolean; maxFileBytes: number; maxFiles: number; maxTotalBytes: number;
};
/** Support describes implementation; availability and permissions describe this exact scope.
 * Unknown permissions are deliberately null and never authorize an operation. */
export type FeatureSupport = {
  supported: boolean; availability: 'available' | 'unavailable' | 'unknown'; reason: FeatureReason | null;
  scope: FeatureScope; permissions: { read: boolean | null; write: boolean | null };
  constraints: SubmissionConstraints | null;
};
export function featureSupport(supported: boolean, scope: FeatureScope, options: {
  availability?: FeatureSupport['availability']; reason?: FeatureReason | null;
  read?: boolean | null; write?: boolean | null; constraints?: SubmissionConstraints | null;
} = {}): FeatureSupport {
  return { supported, scope, availability: supported ? options.availability ?? 'unknown' : 'unavailable',
    reason: !supported ? options.reason ?? 'provider_unavailable' : options.reason === undefined ? 'requires_detail' : options.reason,
    permissions: { read: supported ? options.read ?? null : false, write: supported ? options.write ?? null : false },
    constraints: options.constraints ?? null };
}

export type FeatureServices = { assignmentSubmission: boolean; manualVideo: boolean; playbackStart: boolean; playbackReady: boolean };
/** No school requests or per-target permission guesses are made by the service discovery route. */
export function providerFeatures(provider: SchoolProvider, services: FeatureServices) {
  const read = (supported: boolean) => featureSupport(supported, 'service', {
    reason: supported ? 'requires_school_read' : 'provider_unavailable', write: false,
  });
  const target = (supported: boolean) => featureSupport(supported, 'service');
  const playbackSupported = provider.capabilities.playback && Boolean(provider.authorizePlayback && provider.preparePlayback
    && provider.play && provider.validatePlayback && provider.playbackLearningStatus);
  return {
    authentication: featureSupport(Boolean(provider.capabilities.schoolAuthentication && provider.auth), 'service', { reason: null }),
    dashboard: read(Boolean(provider.dashboard)), courses: read(Boolean(provider.courses)), course_terms: read(Boolean(provider.courseTerms)),
    weeks: read(Boolean(provider.course)), notices: featureSupport(false, 'service', { reason: 'not_implemented' }),
    materials: read(Boolean(provider.course)), material_content: read(Boolean(provider.material)), assignments: read(Boolean(provider.assignments)),
    assignment_detail: read(Boolean(provider.assignment)), assignment_files: read(Boolean(provider.assignmentFile)),
    assignment_history: read(Boolean(provider.assignmentHistory)), assignment_submission: target(services.assignmentSubmission),
    quizzes: featureSupport(false, 'service', { reason: 'not_implemented' }), attendance: read(Boolean(provider.attendance)),
    timetable: read(Boolean(provider.timetable)), tasks: read(Boolean(provider.tasks)), calendar: read(Boolean(provider.calendar)),
    syllabus: read(Boolean(provider.syllabus && provider.syllabusMaterial)), manual_video: target(services.manualVideo && Boolean(provider.video)),
    manual_video_progress: target(services.manualVideo && Boolean(provider.video)),
    material_view: target(Boolean(provider.recordMaterialView)), learning_status: read(Boolean(provider.learningStatus)),
    server_playback: featureSupport(playbackSupported, 'service', {
      availability: playbackSupported && !services.playbackReady ? 'unavailable' : 'unknown',
      reason: !playbackSupported ? 'provider_unavailable' : !services.playbackReady ? 'runtime_not_ready' : 'requires_detail',
      ...(!playbackSupported || !services.playbackReady ? { write: false } : {}),
    }),
    playback_start: target(services.playbackStart),
  } satisfies Record<string, FeatureSupport>;
}

/** Uses only verified options already fetched for this assignment; no new reads/writes. */
export function submissionFeature(options: SchoolOptions, inProgress = false): FeatureSupport {
  const reasons: FeatureReason[] = ['conditions_unknown', 'locked', 'attempts_exhausted', 'unsupported_mode', 'group_submission'];
  const reason = options.blockedReason === null && options.supported ? inProgress ? 'submission_in_progress' : null
    : reasons.includes(options.blockedReason as FeatureReason) ? options.blockedReason as FeatureReason : 'conditions_unknown';
  const allowed = options.supported && reason === null;
  return featureSupport(!['unsupported_mode', 'group_submission'].includes(reason ?? ''), 'assignment', {
    availability: allowed ? 'available' : reason === 'conditions_unknown' ? 'unknown' : 'unavailable',
    reason, read: true, write: allowed,
    constraints: { modes: [...options.modes], allowedExtensions: options.allowedExtensions ? [...options.allowedExtensions] : null,
      expectedAttempt: options.expectedAttempt, pledgeRequired: options.pledge.required,
      maxFileBytes: limits.maxFileBytes, maxFiles: limits.maxFiles, maxTotalBytes: limits.maxTotalBytes },
  });
}
