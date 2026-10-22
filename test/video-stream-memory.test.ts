import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('an active stream releases consumed unique byte chunks instead of retaining the whole download', { timeout: 15_000 }, async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ['--expose-gc', '--import', 'tsx', fileURLToPath(new URL('./helpers/video-stream-memory-fixture.mjs', import.meta.url))],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10_000, maxBuffer: 16 * 1024 });
  assert.equal(stderr, '');
  const value = JSON.parse(stdout);
  assert.equal(value.produced, 256);
  assert.equal(value.received, 64 * 1024 * 1024);
  assert.equal(value.cancellations, 1);
  // Allow runtime/queue headroom, while rejecting retention of a 64-MiB
  // download whose distinct chunks have already been consumed and discarded.
  assert.ok(value.retainedArrayBufferBytes < 16 * 1024 * 1024,
    `consumed bytes retained during active stream: ${value.retainedArrayBufferBytes}`);
});
