import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SchoolError } from '@alms/ssu-api';
import { PDFDocument } from 'pdf-lib';
import { createSyllabusRuntime, SyllabusRuntimeError } from '../dist/syllabus-runtime.js';
import { syllabusFixture } from './syllabus-runtime-fixture.mjs';

// Entire school transport is synthetic. Run in --network none with no production environment or volumes.
const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = await pdf.save();
const scenarios = ['success', 'blocked-url', 'before-auth-post', 'redirect', 'invalid-pdf', 'wrong-pagecount', 'denied-auth', 'abort'];
const results = []; let processes = 0, exited = 0;
for (const scenario of scenarios) {
  const source = await syllabusFixture();
  let server, auth = 0, reports = 0, requests = 0; const pdfStages = [];
  const controller = new AbortController();
  const output = JSON.stringify({ 'syllabus.pdf': Buffer.from(scenario === 'invalid-pdf' ? '%PDF-1.7\nbad\n%%EOF' : bytes).toString('base64') });
  const runtime = createSyllabusRuntime({ observePdfStage: function(stage) {
    assert.equal(arguments.length, 1); pdfStages.push(stage); throw new Error('synthetic observer failure');
  }, launch: async () => {
    server = await chromium.launchServer({ headless: true, chromiumSandbox: true, host: '127.0.0.1', timeout: 20000,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); processes++;
    return { server, browser: await chromium.connect(server.wsEndpoint(), { timeout: 5000 }) };
  }, fetch: async (input, init) => {
    requests++; const url = new URL(String(input));
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers); assert.equal(headers.has('cookie'), false); assert.equal(headers.has('authorization'), false);
    if (url.pathname === '/oz70/authcheck_utf.js') {
      if (scenario === 'redirect') return new Response('', { status: 302, headers: { location: 'https://evil.test' } });
      const script = `
        function requestSend(){
          ${scenario === 'before-auth-post' ? "fetch('/oz70/server',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'synthetic'}); return;" : ''}
          ${scenario === 'blocked-url' ? "fetch('https://evil.test/private'); return;" : ''}
          const s=document.createElement('script');s.src='https://ecc.ssu.ac.kr/sap/bc/bsp/sap/z_oz_authcheck/check.htm?callback=jQuery1_2';document.head.append(s);
        }
        function jsonpCallback(){ call(); }
        async function start_ozjs(){
          await fetch('/oz70/ozhviewer/res/viewer_server_error_msg_en_US.xml');
          await fetch('/oz70/server',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'synthetic'});
          const v=document.getElementById('OZViewer');
          v.GetInformation=()=> '${scenario === 'wrong-pagecount' ? '2' : '1'}';
          v.ScriptEx=(command,options,delimiter)=>{
            if(command!=='save_memorystream'||!options.includes('export.format=pdf')||delimiter!==';')throw Error();
            queueMicrotask(()=>window.OZExportMemoryStreamCallBack_OZViewer(${JSON.stringify(output)})); return 0;
          };
        }`;
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    }
    if (url.pathname === '/oz70/ozhviewer/res/viewer_server_error_msg_en_US.xml') {
      assert.equal(init.method, 'GET'); return new Response('<ROOT/>', { headers: { 'content-type': 'text/xml' } });
    }
    assert.equal(url.pathname, '/oz70/server'); assert.equal(init.method, 'POST'); reports++;
    return new Response('synthetic-report-bytes', { headers: { 'content-type': 'application/octet-stream' } });
  } });
  let result, failure;
  try {
    result = await runtime({ plan: source.plan, validate: async () => {}, readAuthCheck: async () => {
      auth++; if (scenario === 'denied-auth') throw new SyllabusRuntimeError('UPSTREAM_FAILED');
      if (scenario === 'abort') { controller.abort(); return new Promise(() => {}); }
      return { body: 'jsonpCallback();', contentType: 'text/javascript' };
    } }, controller.signal);
  } catch (error) { failure = error; }
  if (scenario === 'success') { assert.ok(result); assert.equal(result.pageCount, 1); assert.deepEqual(Buffer.from(result.bytes), Buffer.from(bytes)); assert.equal(auth, 1); assert.equal(reports, 1);
    assert.deepEqual(pdfStages, ['callback_received', 'inspection_started', 'inspection_passed', 'normalization_passed']); }
  else { assert.ok(failure instanceof SyllabusRuntimeError || failure instanceof SchoolError, `expected normalized failure for ${scenario}`); assert.equal(result, undefined); }
  assert.ok(server); assert.ok(server.process().exitCode !== null || server.process().signalCode !== null); exited++;
  results.push({ scenario, passed: true, ...(failure ? { failureCode: failure.code } : {}), pdfStages, requests, authChecks: auth, syntheticReportReads: reports, processExited: true });
}
console.log(JSON.stringify({ kind: 'syllabus-synthetic-browser-qa', scenarios: results, processes, exited,
  schoolRequests: 0, schoolProgressWrites: 0, productionCredentials: false, sandbox: true }, null, 2));
