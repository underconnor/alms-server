# Manual video contract

This document describes the current manual video API. See [OpenAPI](openapi.json) for exact request and response schemas.

Owned activity detail provides separate `manualVideoAvailable` and `manualVideoReportAvailable` flags. Use exact `Accept: application/json; alms-manual-video=untracked` for the attendance-bearing byte representation. Legacy `manualVideoProgressMode:'untracked'` describes byte delivery alone; it does not mean separate reporting APIs are absent. `not_applicable` means the school explicitly excludes attendance. Unknown or unsupported detail remains false/null. Current `featureSupport` provides reasons and permissions.

Authenticated `/media` GET/HEAD rechecks ownership, publication/open state, school generation and exact school-issued source. It supports a single byte range and a 4 GiB streamed file ceiling, not a full memory allocation. Source URLs and student callbacks stay server-side. Native video uses same-site cookie authentication. Cross-site bearer frontends need authenticated fetch because a native media element cannot attach Authorization and client headers.

## Real manual progress lifetime

1. Start `/manual-playback` with `{}` as part of explicit normal playback. It returns `{playbackId,nonce,heartbeatIntervalMs:5000,reportIntervalMs:300000,maxInitialPositionSeconds,state:'ready'}` and binds the process-local lifetime to owner, ALMS session, school generation and exact target.
2. POST `/manual-playback/:playbackId/observations` with `{nonce,sequence,observation}`. Sequence is previous accepted sequence +1. Observation contains actual `positionSeconds`, `durationSeconds`, `playbackRate:1`, `paused`, `ended`, `seeking:false`, `visible:true`. More than 15 seconds without an accepted observation expires the lifetime; maximum lifetime is four hours.
3. POST `/reports` with `{nonce,reportSequence,event}` after an accepted observation. Event is `playing|update|unload|ended`. Report sequence is previous report +1; periodic update is at least 300000 ms after the previous report. Result contains `report:'acknowledged'|'unknown'`, `state:'ready'|'closed'` and school result.
4. A pause/navigation/ended flow sends its appropriate terminal report before local disposal when possible. POST `/stop` with `{nonce}` disposes the local lifetime and returns `state:'closed'`; this is not a school report ACK. Do not replay uncertain reports or manufacture completion from elapsed wall time. Read `/learning-status` to confirm school progress.

### Optional timing for actual manual snapshots

Preparation may additionally return `observationTiming:'client_monotonic_v1'`. This capability is emitted only when the installed school SDK and this exact SDK-owned prepared driver both support it. Its absence preserves the legacy request and elapsed-time checks; clients must not assume support from a deployment name or package version.

When advertised, a frontend may include `observation.capturedAtMs`, the finite nonnegative `performance.now()` value captured with that actual native media snapshot (maximum `Number.MAX_SAFE_INTEGER`). The first observation fixes timed or legacy mode for this playback lifetime. A timed lifetime must keep the same monotonic clock epoch and field on every observation; a legacy lifetime must keep omitting it. A reload/new player must obtain a new lifetime rather than resetting this clock in an existing one. Reverse/nonfinite values, stale gaps and impossible clock/progress bounds are rejected. The server's receipt clock, live-session/lease checks, 15-second observation freshness and report freshness remain authoritative. Captured timing does not add cumulative watch time, prove attendance or authorize seeking/faster/hidden playback.

Network variation can compress the arrival interval of two genuine 1x snapshots. The timed adapter evaluates the actual snapshot interval while keeping the SDK's server and client clock bounds; native school-player/worker observation guards retain their existing protocol. This field is not accepted by `/reports`, `/stop` or explicit school restart confirmation. Legacy observations remain valid even when the capability is advertised.

An observation failure keeps the existing normalized API error. With a valid optional trace UUID, a separate fixed `manual_observation_rejected` log records only that trace and an allowlisted SDK validation `kind`. It contains no observation body, media position, timing values, learner, token or school target. Missing diagnostics do not prove a request was accepted or identify a past failure's cause. Reporting retries and timeout limits are unchanged.

Every write retains Origin, CSRF, owner, generation, sequential observation and shared playback lease checks. A reporting failure may have reached school, so its bounded lease and previous result are preserved. Historical or ended courses expose byte viewing but do not authorize progress reporting. School completion, attendance and recognition remain separate observations.

## Explicit school restart

`POST /playback-start-confirmations` prepares `{confirmationId,nonce,expiresAt}` for two minutes. The user reads the impact notice and confirms `/playback-start-confirmations/:confirmationId/confirm` with `{nonce,observation}` while the player is visible, paused, not ended, not seeking and at 1x. School may stop another content's progress tracking. Result is `confirmed` with timestamp or `verification_required` with null timestamp, both with school result. Reservation or background execution does not substitute for confirmation. Unknown writes are not automatically repeated.

Synthetic tests, real browser playback, school progress, execution ending and school attendance recognition are distinct evidence. Endpoint support alone does not claim a live school report was accepted or attendance recognized.
