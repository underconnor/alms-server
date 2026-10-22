# School report outcome diagnostics

School transmission and later result validation are separate stages. A response can be acknowledged while a subsequent school read, session validation, cache refresh or persistence step fails. The diagnostic must preserve that distinction without turning an unknown outcome into success.

Only the fixed classifications allowed by [`src/video-report-diagnostics.ts`](../src/video-report-diagnostics.ts) are retained. No response body, original callback URL, user identity, token, cookie, stack or unbounded error text is logged. Missing diagnostic fields remain unknown.

Diagnostics do not relax acknowledgement parsing, change the report deadline, retry a school write or release an uncertain lease. A later successful read does not attribute a prior write to ALMS.

## Validation

[`test/video-report-diagnostics.test.ts`](../test/video-report-diagnostics.test.ts) covers classification and privacy boundaries. Related [manual video tests](../test/manual-video-school.test.ts) exercise the school adapter with synthetic transport. Run the relevant tests against the current package; their results do not establish an actual school response, production failure cause or attendance outcome.
