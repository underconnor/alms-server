# Explicit-start acknowledgement

An explicit school restart and ordinary playing/update/ended reports use separate acknowledgement rules. The SDK's explicit-start parser requires strict `result: true` with its own-field, schema and JSONP checks. Ordinary progress reports retain the `error_code: null` success condition.

An acknowledgement does not establish completion or attendance. The one-use confirmation, current session authority, shared lease, fresh school reads and no-retry policy remain required. Previously unknown attempts are not reclassified from a later observation.

See [`src/playback-start-school.ts`](../src/playback-start-school.ts), [`test/playback-start-school.test.ts`](../test/school-playback-start.test.ts) and the [explicit recovery contract](explicit-playback-recovery.md). Actual school responses and deployment behavior require separate verification.
