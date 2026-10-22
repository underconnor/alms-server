import test from 'node:test';
import assert from 'node:assert/strict';
import { assignmentFileDisposition, createAssignmentFileCache, publicAssignmentFile } from '../src/assignment-files.js';
const proof = { id: '7', fileName: '답안.pdf', contentType: 'application/pdf', sizeBytes: 8, downloadAvailable: true };
const raw = () => ({ fileId: '7', fileName: '답안.pdf', contentType: 'application/pdf; charset=binary', bytes: Buffer.from('%PDF-abc') });
test('assignment file output binds the file ID, byte size and PDF magic and makes other MIME downloadable', () => {
  const pdf = publicAssignmentFile(raw(), proof); assert.equal(pdf.previewAvailable, true); assert.equal(pdf.contentType, 'application/pdf');
  for (const input of [{ ...raw(), fileId: '8' }, { ...raw(), bytes: Buffer.from('bad-data') }, { ...raw(), bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }, { ...raw(), contentType: 'application/pdf\r\nx-leak: yes' }])
    assert.throws(() => publicAssignmentFile(input, proof), { code: 'ASSIGNMENT_FILE_UNAVAILABLE' });
  const active = publicAssignmentFile({ ...raw(), contentType: 'image/svg+xml' }, { ...proof, contentType: 'image/svg+xml' });
  assert.equal(active.contentType, 'application/octet-stream'); assert.equal(active.previewAvailable, false);
  assert.match(assignmentFileDisposition(active, false), /^attachment;/);
});
test('disposition sanitizes filenames and encodes Unicode without executing school header text', () => {
  const pdf = publicAssignmentFile({ ...raw(), fileName: "../한글\r\n\"'().pdf" }, proof);
  const header = assignmentFileDisposition(pdf, false); assert.match(header, /^inline; filename="attachment-7.pdf";/);
  assert.doesNotMatch(header, /[\r\n]/); assert.match(header, /%ED%95%9C%EA%B8%80/); assert.match(header, /%27%28%29/);
  assert.match(assignmentFileDisposition(pdf, true), /^attachment;/);
});
test('private bytes isolate owners/generations/metadata and retain the original TTL', t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const cache = createAssignmentFileCache(), file = publicAssignmentFile(raw(), proof);
  cache.put('a', 'generation-one', '10:90:7', proof, file);
  assert.equal(cache.get('a', 'generation-one', '10:90:7', proof), file);
  assert.equal(cache.get('b', 'generation-one', '10:90:7', proof), null);
  assert.equal(cache.get('a', 'generation-one', '10:90:7', { ...proof, sizeBytes: 9 }), null);
  now += 4 * 60_000; assert.equal(cache.get('a', 'generation-one', '10:90:7', proof), file);
  now += 61_000; assert.equal(cache.get('a', 'generation-one', '10:90:7', proof), null);
  cache.put('a', 'generation-one', '10:90:7', proof, file); assert.equal(cache.get('a', 'generation-two', '10:90:7', proof), null);
  assert.equal(cache.get('a', 'generation-one', '10:90:7', proof), null);
});
test('download names remain valid Unicode at the existing length boundary', () => {
  for (const fileName of ['a'.repeat(239) + '😀.pdf', 'a'.repeat(238) + '😀.pdf', 'name-\ud800.pdf', 'name-\udc00.pdf']) {
    const file = publicAssignmentFile({ ...raw(), fileName }, proof);
    assert.ok(file.fileName.length <= 240); assert.equal(file.fileName.isWellFormed(), true);
    const header = assignmentFileDisposition(file, true);
    assert.match(header, /^attachment;/); assert.doesNotMatch(header, /[\r\n]/);
    assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]!), file.fileName);
  }
  assert.equal(publicAssignmentFile({ ...raw(), fileName: 'a'.repeat(239) + '😀.pdf' }, proof).fileName, 'a'.repeat(239));
  assert.equal(publicAssignmentFile({ ...raw(), fileName: 'a'.repeat(238) + '😀.pdf' }, proof).fileName, 'a'.repeat(238) + '😀');
});
test('original school names survive normalization, private caching and response encoding', () => {
  const name = "설계 안내 (최종) 😀 '자료'.pdf";
  const file = publicAssignmentFile({ ...raw(), fileName: name }, { ...proof, fileName: '강의자료' });
  const cache = createAssignmentFileCache(); cache.put('owner', 'g', '10:90:7', proof, file);
  const cached = cache.get('owner', 'g', '10:90:7', proof)!;
  assert.equal(cached.fileName, name); assert.equal(cached.bytes, file.bytes);
  const header = assignmentFileDisposition(cached, false);
  assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]!), name);
  assert.equal(cache.get('other-owner', 'g', '10:90:7', proof), null);
});
test('private file cache enforces per-owner and global byte limits and scoped invalidation', () => {
  const cache = createAssignmentFileCache(), file = { ...publicAssignmentFile(raw(), proof), bytes: Buffer.alloc(20 * 1024 * 1024) };
  cache.put('a', 'g', '10:90:7', proof, file); cache.put('a', 'g', '20:90:7', proof, file);
  assert.equal(cache.get('a', 'g', '10:90:7', proof), null); assert.equal(cache.get('a', 'g', '20:90:7', proof), file);
  cache.put('b', 'g', '10:90:7', proof, file); cache.put('c', 'g', '10:90:7', proof, file); cache.put('d', 'g', '10:90:7', proof, file);
  assert.equal(cache.get('a', 'g', '20:90:7', proof), null);
  cache.invalidate('b', '10'); assert.equal(cache.get('b', 'g', '10:90:7', proof), null); assert.equal(cache.get('c', 'g', '10:90:7', proof), file);
});
test('file loader limits concurrent school downloads and a cancelled queued caller never starts', async () => {
  const cache = createAssignmentFileCache(); let active = 0, maximum = 0, entered = 0, release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), controller = new AbortController();
  const run = async () => { entered++; active++; maximum = Math.max(maximum, active); await wait; active--; };
  const first = cache.load(new AbortController().signal, run), second = cache.load(new AbortController().signal, run), third = cache.load(controller.signal, run);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, 2); const rejected = assert.rejects(third); controller.abort(); await rejected;
  release(); await Promise.all([first, second]); assert.equal(entered, 2); assert.equal(maximum, 2);
  await cache.load(new AbortController().signal, async () => { entered++; }); assert.equal(entered, 3);
});
