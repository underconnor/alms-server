import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@alms/ssu-api';
import { manualVideoObservationTiming, supportedManualVideoObservationTiming } from '../src/manual-video-timing.js';

test('manual timing capability needs the exact installed and prepared driver values', () => {
  const accepted = 'client_monotonic_v1';
  for (const installed of [undefined, null, false, {}, 'client_monotonic_v2', accepted])
    for (const prepared of [undefined, null, false, {}, 'client_monotonic_v2', accepted])
      assert.equal(supportedManualVideoObservationTiming(installed, prepared),
        installed === accepted && prepared === accepted ? accepted : undefined);
});

test('runtime capability cannot be advertised solely from a driver assertion', () => {
  const installed = sdk as unknown as { SCHOOL_MANUAL_VIDEO_OBSERVATION_TIMING?: unknown };
  assert.equal(manualVideoObservationTiming({}), undefined);
  assert.equal(manualVideoObservationTiming({ observationTiming: 'client_monotonic_v1' }),
    installed.SCHOOL_MANUAL_VIDEO_OBSERVATION_TIMING === 'client_monotonic_v1' ? 'client_monotonic_v1' : undefined);
});
