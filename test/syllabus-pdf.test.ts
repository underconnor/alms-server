import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { inspectSyllabusPdf } from '../src/syllabus-pdf-inspector.js';
import { syllabusRequestRole, validateSyllabusRuntimePdf, type SyllabusPdfStage } from '../src/syllabus-runtime.js';

test('PDF diagnostics expose only fixed stages and observer failure cannot alter validation', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const output = JSON.stringify({ 'synthetic.pdf': bytes.toString('base64') }), stages: SyllabusPdfStage[] = [];
  const result = await validateSyllabusRuntimePdf(output, new AbortController().signal, function(stage) {
    assert.equal(arguments.length, 1); stages.push(stage); throw new Error('ignored observer error');
  });
  assert.deepEqual(stages, ['callback_received', 'inspection_started', 'inspection_passed', 'normalization_passed']);
  assert.deepEqual(Buffer.from(result.bytes), bytes); assert.equal(result.pageCount, 1);
});
test('PDF diagnostics distinguish normalization input rejection from structural parser rejection without raw output', async () => {
  for (const [output, expected] of [
    ['{}', ['callback_received']],
    [JSON.stringify({ 'synthetic.pdf': Buffer.from('%PDF-1.7\ninvalid\n%%EOF').toString('base64') }), ['callback_received', 'inspection_started']],
  ] as const) {
    const stages: SyllabusPdfStage[] = [];
    await assert.rejects(validateSyllabusRuntimePdf(output, new AbortController().signal, stage => stages.push(stage)));
    assert.deepEqual(stages, expected); assert.equal(JSON.stringify(stages).includes('synthetic'), false);
  }
});

test('PDF structure parser returns actual pages and rejects malformed, oversized, aborted and empty documents', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
  assert.deepEqual(await inspectSyllabusPdf(await pdf.save()), { pageCount: 2 });
  const empty = await PDFDocument.create();
  for (const bytes of [Buffer.from('%PDF-1.7\nnot a document\n%%EOF'), Buffer.alloc(16 * 1024 * 1024 + 1), await empty.save({ addDefaultPage: false })])
    await assert.rejects(inspectSyllabusPdf(bytes));
  await assert.rejects(inspectSyllabusPdf(await pdf.save(), AbortSignal.abort()));
});
test('syllabus network allows only exact observed static/auth/report roles', () => {
  const office = 'https://office.ssu.ac.kr';
  for (const prefix of ['server_error_msg_', 'viewer_server_error_msg_', 'chartres_', 'qd_error_msg_', 'rm_error_msg_',
    'em_error_msg_', 'viewer_error_msg_', 'rr_error_msg_', 'ad_error_msg_', 'av_error_msg_', 'as_error_msg_', 'af_error_msg_', 'rd_error_msg_'])
    assert.equal(syllabusRequestRole(office + '/oz70/ozhviewer/res/' + prefix + 'en_US.xml', 'xhr', 'GET'), 'static');
  for (const path of ['/oz70/ozhviewer/res/viewer_server_error_msg_en_us.xml', '/oz70/ozhviewer/res/viewer_server_error_msg_ko_KR.xml',
    '/oz70/ozhviewer/viewer_server_error_msg_en_US.xml', '/oz70/ozhviewer/res/unknown_en_US.xml', '/oz70/ozhviewer/res/viewer_server_error_msg_en_US.xml?x=1'])
    assert.equal(syllabusRequestRole(office + path, 'xhr', 'GET'), null);

  assert.equal(syllabusRequestRole(office + '/oz70/ozhviewer/OZJSViewer.js', 'script', 'GET'), 'static');
  assert.equal(syllabusRequestRole(office + '/oz70/ozhviewer/OZJSViewer_export.js?Version%20-%2070%2C2021%2C0714%2C100', 'xhr', 'GET'), 'static');
  assert.equal(syllabusRequestRole(office + '/oz70/server', 'xhr', 'POST'), 'report');
  assert.equal(syllabusRequestRole('https://ecc.ssu.ac.kr/sap/bc/bsp/sap/z_oz_authcheck/check.htm?callback=jQuery1_2', 'script', 'GET'), 'auth');
  for (const [url, kind, method] of [[office + '/oz70/ozreflect', 'xhr', 'POST'], [office + '/oz70/server?other=1', 'xhr', 'POST'],
    [office + '/oz70/server', 'xhr', 'GET'], [office + '/oz70/server', 'document', 'POST'],
    [office + '/oz70/ozhviewer/OZJSViewer.js?x=1', 'script', 'GET'], [office + '/oz70/ozhviewer/OZJSViewer.js', 'script', 'POST'],
    ['https://evil.test/oz70/server', 'xhr', 'POST'], [office + '/oz70/ozhviewer/../admin.jsp', 'script', 'GET'],
    ['http://office.ssu.ac.kr/oz70/server', 'xhr', 'POST'], ['https://user@office.ssu.ac.kr/oz70/server', 'xhr', 'POST']])
    assert.equal(syllabusRequestRole(url!, kind!, method!), null);
});

test('runtime transport bounds fetch, stream, redirect and late response cleanup without forwarding credentials', async () => {
  const { readSyllabusRuntimeResponse } = await import('../src/syllabus-runtime.js');
  let called = false;
  await assert.rejects(readSyllabusRuntimeResponse(async () => { called = true; return new Response('unused'); }, 'https://office.ssu.ac.kr/oz70/server', {}, 100, AbortSignal.abort()));
  assert.equal(called, false);
  let resolve!: (response: Response) => void, cancelled = false;
  const loading = readSyllabusRuntimeResponse(async () => new Promise<Response>(done => { resolve = done; }), 'https://office.ssu.ac.kr/oz70/server', {}, 100, new AbortController().signal, 10);
  await assert.rejects(loading);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
  let streamCancelled = false;
  await assert.rejects(readSyllabusRuntimeResponse(async () => new Response(new ReadableStream({ cancel() { streamCancelled = true; return new Promise(() => {}); } })),
    'https://office.ssu.ac.kr/oz70/server', {}, 100, new AbortController().signal, 10));
  assert.equal(streamCancelled, true);
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('xx', { headers: { 'content-length': '999' } }), new Response('x'.repeat(101))])
    await assert.rejects(readSyllabusRuntimeResponse(async () => response, 'https://office.ssu.ac.kr/oz70/server', {}, 100, new AbortController().signal));
  const result = await readSyllabusRuntimeResponse(async (_url, init) => {
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit');
    assert.deepEqual(init?.headers, {}); return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  }, 'https://office.ssu.ac.kr/oz70/server', { headers: {} }, 100, new AbortController().signal);
  assert.equal(result.body.toString(), 'ok');
});
