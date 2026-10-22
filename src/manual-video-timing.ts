import * as schoolSdk from '@alms/ssu-api';
import type { PreparedManualVideo } from './manual-video-types.js';

const timing = 'client_monotonic_v1' as const;
export function supportedManualVideoObservationTiming(installed: unknown, prepared: unknown) {
  return installed === timing && prepared === timing ? timing : undefined;
}
/** Both the installed SDK and this exact prepared driver must support the contract. */
export function manualVideoObservationTiming(driver: Pick<PreparedManualVideo, 'observationTiming'>) {
  const installed = schoolSdk as unknown as { SCHOOL_MANUAL_VIDEO_OBSERVATION_TIMING?: unknown };
  return supportedManualVideoObservationTiming(installed.SCHOOL_MANUAL_VIDEO_OBSERVATION_TIMING, driver.observationTiming);
}
