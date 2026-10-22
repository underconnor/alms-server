# Personal learning completion

These records belong to ALMS study planning. They do not change the school module completion, attendance, submission, or playback eligibility. An explicit `false` takes precedence over the school default in the client, just as `true` does. Deleting an override restores the current school default.

- `GET /v1/courses/:id/completions` returns `{items: [{courseId, activityId, completed, updatedAt}]}` for the authenticated owner and exact course. This is a DB-only read and does not contact the school or require an active school session.
- `PATCH /v1/courses/:id/activities/:activityId/completion` accepts only `{completed: boolean}` and returns the saved row.
- `DELETE` at the same activity path has no body and returns `204`. Reset is idempotent.

All paths use module activity IDs, including assignments, rather than assignment submission IDs. Writes revalidate the permitted school course DTO and a unique activity with the same course ID. An explicit `published: false` is rejected. Missing or `null` publication metadata is accepted for personal planning because visible assignment modules may omit that metadata. Every module type is supported. Past course reads may authorize personal planning; this does not expand any school write permission. Missing or ambiguous activities remain rejected. School authentication failure prevents a new write; existing personal records remain readable with a valid ALMS session.

Writes require the normal Origin and CSRF checks, followed by a live ALMS session check after the course lookup. The DB transaction locks that same owner/token/CSRF session through commit and checks expiry after the mutation. Logout, account changes, or delayed row locks cannot authorize a stale write. Reads revalidate the same session before returning rows.

Migration `010-personal-learning-completion.sql` stores owner, course, activity, explicit boolean, and update time. Records are independent of school session generations and cache entries. The verified school identity preserves the ALMS user ID across relogin. User deletion cascades to personal records; logout and school authentication replacement preserve them. Readiness requires migration 010. School record/report APIs are separate from these personal records.

Behavior tracking uses only the fixed actions `set_learning_complete`, `set_learning_incomplete`, `reset_learning_completion` and operations `load_learning_completion`, `save_learning_completion`. Existing button/duration/error properties apply; course/activity identifiers, titles, content, and URLs are rejected. Save timing ends when the saved personal state is displayed and does not measure school completion or attendance recognition.

## TODO and calendar backlinks

`GET /v1/tasks` overlays fresh owner completion records only after an exact verified assignment or Commons relation provides `moduleItemId` and `weekId`. A cold read or school relogin may load module metadata only for supported pending-task courses with an existing owner override. It never fans out across all enrolled courses, reads lesson/material data, or uses task hashes as activity IDs. true/false remain explicit; reset null restores the observed school default when a current exact module proof exists. Missing or ambiguous relations remain unlinked. A task absent from the school's pending feed is not synthesized from a personal record.

Commons `readystream` TODOs may receive a body backlink only when the SDK verifies one explicit attendance item ID in the same course and the current owner/generation module proof is unique. The public shape stays unchanged: `type: 'other'`, `playbackAvailable: false`, `schoolStatus: null` and `progressPercent: null`. The backlink does not add activity-detail, playback or school progress support, and its `moduleCompleted` remains null. Stale task/course mapping caches cannot provide this relation. Reading the selected course then rereading tasks can provide the exact `moduleItemId` and `weekId`; no title fallback or full-course module fanout is added.

`GET /v1/calendar` uses the same bounded module-proof lookup for assignments in the selected period, including submitted assignments absent from TODO. Its separate `personalCompleted` field never replaces the real school `userSubmitted` flag. Cached school JSON contains no personal values. Each response reads the latest owner records and validates its original private proof against one final ALMS/school SQL snapshot. Reads have a 90-second request bound; cancellation cannot publish an old response or start a later module lookup.

The canonical Front task source is `/v1/tasks`. The legacy full `/v1/dashboard` adapter keeps its original school pending-feed projection and does not attach DB overrides. Dashboard Front joins the canonical tasks response rather than treating that legacy field as personal-completion authority.
