# Manual video progress reporting

The browser's native video element remains the player. Preparation creates an owner-bound reporting context without a school write. Actual visible 1× playback supplies media observations; server and SDK bounds reject seeking, gaps, fabricated cumulative time and unsupported duration or type changes. Reports are separate from observations.

Routes below `/v1/courses/:id/activities/:activityId/manual-playback` create the context, accept `/observations`, forward `/reports`, and `/stop`. Every write requires the current ALMS session, Origin and CSRF. A nonce remains in frontend memory; its hash and owner/generation/target bind a PostgreSQL lease. Requests do not accept a school URL or user ID.

Preparation restores that user's jar and validates native identity, enrollment and the exact activity and issued callback. Each report repeats the authority checks, sends once and reads fresh school state. Acknowledgement is separate from attendance recognition. Unknown responses are not automatically replayed. An interrupted report retains its lease until expiry.

Manual playback requires a live browser session. API shutdown aborts contexts before closing the server. Shared execution leases prevent conflicting manual and server activity. See the [HTTP lifetime contract](manual-video-contract.md), [`src/manual-video-service.ts`](../src/manual-video-service.ts) and [`test/manual-video-service.test.ts`](../test/manual-video-service.test.ts).
