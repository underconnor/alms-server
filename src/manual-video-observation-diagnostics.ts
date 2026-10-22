import * as sdk from '@alms/ssu-api';

const kinds = new Set(['playback_shape', 'visibility', 'client_cumulative', 'initial_position', 'initial_baseline', 'duration',
  'server_clock', 'timing_value', 'timing_mode', 'client_clock_reverse', 'observation_gap', 'client_clock_ahead',
  'clock_residual', 'pair_clock_drift', 'position_reverse', 'pair_progress', 'inactive_progress', 'lifetime_server_progress', 'lifetime_client_progress']);
const failures = new WeakMap<object, string>();

/** Only a fixed SDK kind crosses normalization; source bodies and timing values never do. */
export function projectManualVideoObservationFailure(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && kinds.has(kind) ? kind : null;
}
export function rememberManualVideoObservationFailure(exposed: object, source: unknown): void {
  const installed = sdk as unknown as { inspectSchoolVideoObservationFailure?: (error: unknown) => unknown };
  try {
    const kind = projectManualVideoObservationFailure(installed.inspectSchoolVideoObservationFailure?.(source));
    if (kind) failures.set(exposed, kind);
  } catch { /* Diagnostics cannot replace an observation failure. */ }
}
export function manualVideoObservationFailureKind(error: unknown): string | null {
  return error && typeof error === 'object' ? failures.get(error) ?? null : null;
}
