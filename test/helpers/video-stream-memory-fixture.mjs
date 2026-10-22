import { createVideoStreamer } from '../../src/video-stream.ts';

// Synthetic in-process bytes only. Keep the stream active during GC so a
// completed transfer cannot hide references retained for its entire lifetime.
if (typeof global.gc !== 'function') throw new Error('GC_REQUIRED');
if (process.argv.slice(2).some(value => value !== '--large')) throw new Error('INVALID_MODE');
const large = process.argv.includes('--large');
const chunkBytes = 256 * 1024, chunks = large ? 4096 : 256, expected = chunkBytes * chunks;
const collect = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
  }
};
let produced = 0, received = 0, cancellations = 0, peakRetainedArrayBufferBytes = 0, reached;
const consumed = new Promise(resolve => { reached = resolve; });
const controller = new AbortController();
const stream = createVideoStreamer(async () => new Response(new ReadableStream({
  pull(value) {
    if (produced < chunks) {
      const bytes = new Uint8Array(chunkBytes);
      bytes.fill(++produced % 251);
      value.enqueue(bytes);
    }
  },
  cancel() { cancellations++; },
}), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(expected + 1) } }),
{ idleMs: 60_000, checkMs: 60_000 });
const result = await stream('synthetic-owner', async () => ({
  contentId: 'synthetic',
  mediaUrl: 'https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/mobile/video.mp4',
  validate: async () => {},
}), { method: 'GET', signal: controller.signal, validate: async () => {} });
await collect();
const before = process.memoryUsage().arrayBuffers;
const reading = (async () => {
  try {
    for await (const part of result.body) {
      received += part.byteLength;
      // Optional larger developer/QA run allocates distinct bytes sequentially
      // and samples live retention each 64 MiB; regular CI uses only 64 MiB.
      if (large && received % (64 * 1024 * 1024) === 0) {
        await collect();
        peakRetainedArrayBufferBytes = Math.max(peakRetainedArrayBufferBytes, process.memoryUsage().arrayBuffers - before);
      }
      if (received === expected) reached();
    }
    throw new Error('EXPECTED_ACTIVE_STREAM');
  } catch (error) {
    if (error?.code !== 'REQUEST_ABORTED') throw error;
  }
})();
try {
  await consumed;
  await collect();
  const retainedArrayBufferBytes = process.memoryUsage().arrayBuffers - before;
  controller.abort();
  await reading;
  console.log(JSON.stringify({ produced, received, retainedArrayBufferBytes, peakRetainedArrayBufferBytes, cancellations }));
} finally {
  controller.abort();
  result.body.destroy();
  await reading.catch(() => {});
}
