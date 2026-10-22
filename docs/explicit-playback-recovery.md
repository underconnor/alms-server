# Explicit playback recovery

Two user-approved actions remain separate from ordinary video reports and each other.

## School progress-check start

`POST /v1/courses/:id/activities/:activityId/playback-start-confirmations` with `{}` performs only fresh authorized reads and returns `{confirmationId,nonce,expiresAt}`. The process-local confirmation is bound to owner, ALMS session, course, activity and prepared school generation for 120 seconds. A process restart discards it.

`POST .../:confirmationId/confirm` accepts `{nonce,observation}`. Observation must be a native paused, visible, non-ended, non-seeking 1x snapshot. SDK 0.3.31 verifies the exact issued target, enrollment, school baseline and duration. The school baseline, never a browser cumulative value, supplies cumulativeTime. The common account lease excludes worker/manual overlap. The separate school start request is attempted once. Ordinary playing/update/ended reporting still rejects force_cancel.

Response is `{state:'confirmed',confirmedAt,schoolResult}` only with ACK and a fresh authorized school result; otherwise a readable uncertain result is `{state:'verification_required',confirmedAt:null,schoolResult}`. ACK is not completion or attendance recognition. An uncertain dispatched request retains the bounded lease and is not replayed. A successful explicit confirmation does not autoplay media or enqueue a server job.

## Interrupted server job settlement

`POST /v1/jobs/:id/settle` accepts `{confirmed:true,expectedUpdatedAt:job.recovery.version}` with the existing playback client and authenticated CSRF contract. The recovery version preserves PostgreSQL microseconds verbatim. It returns `{job,settlementRecorded:true,stateChanged:false}`.

Only an exact interrupted needs_verification execution with durable private termination evidence, no current execution claim and no active account lease can be settled. The adapter proves native runtime closure, permanent report fencing and actual callback drain independently of school ACK. Missing legacy evidence or lease expiry alone cannot produce that proof. Fresh school ownership and a current ALMS session are required for settlement; they never resume the original execution generation.

Migration 011 adds immutable execution/settlement records and a separate settled marker. Original failure status, outcome, error, school result and accepted generation remain unchanged. New admission uses a new explicit idempotency key. Reusing the old key still returns the original job.

## Deployment and verification

Apply migrations with compatible API and worker code. Do not remove saved results, active leases or unknown outcomes during rollback. Readiness and an explicit feature flag are required before accepting server playback.

Run the [start-service tests](../test/playback-start-service.test.ts) and [job-settlement tests](../test/job-settlement.test.ts). Actual school restart, playback and fresh results require a separately authorized scenario; synthetic success does not establish school attendance.
