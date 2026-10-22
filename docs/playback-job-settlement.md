# Interrupted playback job settlement

Settlement is an explicit local action after the server has durable evidence that the exact execution ended. It does not complete a lecture, rewrite a school result, send a playback report, clear a school playback conflict, or retry a job. School playback confirmation uses a separate API and user confirmation.

## Public contract

`POST /v1/jobs/:id/settle` accepts exactly `{ expectedUpdatedAt: job.recovery.version, confirmed: true }`. The version is the server's full UTC microsecond string. Keep it verbatim; the ordinary millisecond `updatedAt` is not the compare-and-swap version.

A successful response is `{ job, settlementRecorded: true, stateChanged: false }`. The original `status`, `executionOutcome`, `errorCode`, `schoolResult`, `updatedAt`, and execution generation stay unchanged. The additive `settledAt`, `settlement.schoolResult`, and `recovery` fields describe local settlement and the separately read school observation. School attendance recognition remains unknown when the source cannot establish it.

`recovery.reason` is `eligible`, `already_settled`, `not_interrupted`, `termination_unconfirmed`, `execution_active`, or `lease_active`. Eligibility is an observation; the transaction rechecks all conditions. A historical interrupted row without a durable proof remains `termination_unconfirmed`.

The request requires the authenticated owner, allowed Origin, CSRF token, supported playback client, exact job version, current school authorization, and a fresh school read. Another school generation can authorize settlement but cannot replace the original execution generation. The school generation must remain the same across the fresh read. A changed job or school authority produces 409. Actual ALMS session expiry produces 401. An uncertain database outcome produces 503 `JOB_SETTLEMENT_UNCONFIRMED`: read the job again rather than optimistically updating it or automatically repeating the write.

The original idempotency key continues to identify the original job. A subsequent explicit playback start must use a new key after confirmed settlement.

## Durable proof and concurrency

The adapter creates an opaque proof only after the exact runtime has stopped, dispatch is permanently fenced, the driver closed successfully, and actual callback promises drained. A bounded wrapper finishing, lease expiry, stale-worker recovery, missing current token, or school acknowledgement is insufficient. The runner asks for the proof after disposal and pending work settle. Proof failure preserves uncertainty.

The store persists the exact original owner, course, activity, accepted generation, and execution token in an immutable termination record. Proof insertion and removal of the current claim occur in one transaction. A stale or changed claim cannot create a late record. Every worker claim records its latest execution token; migration 011 never backfills one for old rows.

Settlement takes the same per-owner PostgreSQL transaction lock as new job admission, worker claim/finalization, and manual/worker lease acquire or renew. It requires no live claim or unexpired lease for that account. Worker lease acquisition and renewal must also match the live original claim. A late old callback, acquire, or renewal cannot resurrect a settled execution. The transaction locks the live ALMS session and current school seal, compares the microsecond version, and rechecks both authority deadlines before commit.

Immutable settlement rows bind the original job and exact termination token to their PostgreSQL timestamp through a composite foreign key. The marker copies that timestamp inside SQL; it never passes through JavaScript Date precision. Null tokens, mismatched attempts, marker clearing, and evidence edits/deletion are rejected by database constraints or triggers.

## Migration and rollback

Migration 011 adds nullable columns and separate tables. No historical status, result, generation, or token is reconstructed. The active-lecture unique index continues to cover every actual active status. It excludes only a `needs_verification` row with an exact settled marker.

Keep migration 011, immutable rows, columns, and its index when rolling back application binaries. Restoring the previous unique index can fail after a settled interrupted job and a newly admitted job coexist for the same activity. Never delete old jobs or evidence to force rollback. A previous binary can read the additive schema; it does not expose settlement or create new proof. Deploy/rollback must still fence admissions and stop the previous worker before changing the execution owner. Mixed old and new execution binaries are unsupported.

## Verification boundary

Unit tests use synthetic providers and verify explicit confirmation, CSRF/Origin, exact version, owner, logout, generation changes, school-error propagation, readback on unknown database outcomes, aborted reads, and proof lifecycle. Isolated PostgreSQL tests exercise real row/advisory lock waits, exact timestamp/token foreign keys, durable history preservation, late claims, lease absence races, authority expiry and rotation, duplicate settlement, and immutable evidence. Production school playback and browser confirmation remain separate QA tasks owned by the deployment workflow.
