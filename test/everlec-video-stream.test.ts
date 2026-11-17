import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoStreamer, type PreparedVideoSource } from '../src/video-stream.js';

const noop = async () => {}, signal = () => AbortSignal.timeout(5000);
const url = 'https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/issued_video-01.mp4';
const source = (mediaUrl = url): PreparedVideoSource => ({ contentId: 'synthetic', mediaUrl, resourceType: 'everlec', validate: noop });

test('Everlec exact source sends anonymous HEAD and Range bytes with no callback or school credentials', async () => {
  const requests: string[] = [];
  const stream = createVideoStreamer(async (requested, init) => {
    requests.push(String(requested));
    assert.equal(requested, url); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual');
    assert.deepEqual(init?.headers, { Accept: 'video/mp4', 'Accept-Encoding': 'identity',
      ...(init?.method === 'GET' ? { Range: 'bytes=0-0' } : {}) });
    return new Response(init?.method === 'GET' ? 'x' : null, { status: init?.method === 'GET' ? 206 : 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1', ...(init?.method === 'GET' ? { 'Content-Range': 'bytes 0-0/1' } : {}) } });
  });
  assert.equal((await stream('owner', async () => source(), { method: 'HEAD', signal: signal(), validate: noop })).status, 200);
  const range = await stream('owner', async () => source(), { method: 'GET', range: 'bytes=0-0', signal: signal(), validate: noop });
  assert.equal(range.status, 206); assert.ok(range.body);
  const chunks: Buffer[] = []; for await (const chunk of range.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'x'); assert.equal(requests.length, 2);
});

test('Everlec cannot use movie or Readystream layouts, punctuation repairs or another resource discriminator', async () => {
  let fetches = 0; const stream = createVideoStreamer(async () => { fetches++; throw new Error('must not fetch'); });
  const urls = [url.replace('ssuin-object.', 'foreign.'), url.replace('/synthetic/', '/other/'),
    url.replace('/ssu1000001/', '/ssu1000002/'), url.replace('/contents31/', '/contents29/'),
    url.replace('/media_files/', '/media_files/mobile/'), url.replace('ssuin-object.commonscdn.com/ssu-contents', 'ssu-toast.commonscdn.com'),
    url.replace('-01', '(01)'), url.replace('-01', '%2801%29'), url.replace('issued_', '한글_'),
    url.replace('.mp4', '.m3u8'), url + '?a=1', url + '#x'];
  for (const value of urls) await assert.rejects(stream('owner', async () => source(value),
    { method: 'HEAD', signal: signal(), validate: noop }), { code: 'VIDEO_UNAVAILABLE' });
  for (const resourceType of [undefined, 'readystream'] as const) await assert.rejects(stream('owner', async () => ({ ...source(), resourceType }),
    { method: 'HEAD', signal: signal(), validate: noop }), { code: 'VIDEO_UNAVAILABLE' });
  assert.equal(fetches, 0);
});

test('Everlec byte setup rechecks caller and media authority before fetching or returning an upstream response', async () => {
  let fetches = 0;
  const stream = createVideoStreamer(async () => { fetches++; return new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1' } }); });
  await assert.rejects(stream('owner', async () => source(), { method: 'HEAD', signal: signal(), validate: async () => { throw new Error('session revoked'); } }), { code: 'VIDEO_UNAVAILABLE' });
  await assert.rejects(stream('owner', async () => ({ ...source(), validate: async () => { throw new Error('school generation changed'); } }),
    { method: 'HEAD', signal: signal(), validate: noop }), { code: 'VIDEO_UNAVAILABLE' });
  assert.equal(fetches, 0);
  let checks = 0;
  await assert.rejects(stream('owner', async () => ({ ...source(), validate: async () => { if (++checks === 2) throw new Error('authority changed during HEAD'); } }),
    { method: 'HEAD', signal: signal(), validate: noop }), { code: 'VIDEO_UNAVAILABLE' });
  assert.equal(fetches, 1); assert.equal(checks, 2);
});
