# Explicit school start failure diagnostics

`school_video_start_failed` records only fixed `stage`, `code`, `mayHaveWritten` and optional `responseFailure` values. A process-private record transfers these facts from school transport to the route without changing public errors. Consuming it once prevents a cached confirmation response from logging another transmission.

A transport failure can be followed by a fresh school read with an unknown transmission outcome. If later reading, cache invalidation or authority validation also fails, the first recorded transport failure remains diagnostic evidence. It is not a substitute for the final school state.

Explicit rejection, invalid rate, malformed acknowledgement, authentication failure and network failure remain failures. These records do not prove another video is playing. They never approve a response, invent progress, retransmit a request, relax ownership or release an uncertain lease. No raw body, URL, callback, identity, token, stack or original error value is logged.

See [`src/playback-start-diagnostics.ts`](../src/playback-start-diagnostics.ts) and [`test/playback-start-diagnostics.test.ts`](../test/playback-start-diagnostics.test.ts). Local tests do not establish the cause of a production failure.
