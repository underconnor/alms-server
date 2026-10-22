# School-issued contents29 video1 media

The SDK accepts only the supported contents29 and contents31 layouts bound to an issued single-video manifest. The Backend supports the bounded `/ssu-contents/contents29/ssu1000001/{contentId}/contents/media_files/mobile/{boundedMp4}` source path in addition to its other explicit source rules.

Host, tenant, content, canonical URL, query and filename validation remain required. Arbitrary numbered layouts and guessed fallback URLs are rejected. Range, size, authentication, generation and deadline checks still apply. Media bytes do not themselves report school progress.

See [`src/video-policy.ts`](../src/video-policy.ts), [`src/video-stream.ts`](../src/video-stream.ts) and the [stream contract](video-stream-size.md). Synthetic metadata tests do not establish that every school-issued media layout is supported.
