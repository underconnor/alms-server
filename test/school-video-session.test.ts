import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { videoReportDiagnostic, rememberVideoReportPreparation, rememberVideoReportOutcomeFailure } from '../src/video-report-diagnostics.js';
import { AppError } from '../src/errors.js';
import type { PreparedManualVideo } from '../src/manual-video-types.js';
import { fixture, context, noop, observation } from './helpers/school-video-fixture.js';
const signal = () => AbortSignal.timeout(5000);
const postReportDiagnostic = (result: Awaited<ReturnType<PreparedManualVideo['report']>>,
  reason: 'transport_unknown' | 'nonterminal_controller_closed') => {
  const error=new AppError(503,'PLAYBACK_REPORT_UNKNOWN','fixed');rememberVideoReportPreparation(error,'post_report',true);
  rememberVideoReportOutcomeFailure(error,result,reason);return videoReportDiagnostic(error);
};
test('worker accepted generation is checked before any school request', async () => {
  const f = await fixture();
  await assert.rejects(f.sessions.prepare(context, noop, signal(), randomUUID()), { code: 'SCHOOL_SESSION_CHANGED' });
  assert.equal(f.counts().requests, 0); assert.equal(f.counts().reports, 0);
});
test('closing reporting preserves prepared-bound identity and fresh result reads', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal(), f.generation());
  driver.close(); await driver.validate(signal());
  const school = await driver.readFresh(noop, signal()), authority = await driver.authority(noop, signal());
  assert.equal(school.recognized, null); assert.equal(school.evidence?.resourceType, 'movie');
  assert.equal(authority.generation, f.generation()); assert.equal(authority.encryptedSession, f.encrypted());
  assert.equal(f.counts().reports, 0);
  assert.throws(() => driver.observe(observation));
  await assert.rejects(driver.report('playing', noop, signal()));
  await assert.rejects(driver.prepareMedia(noop, signal()));
});
test('fresh reads and authority stay bound to original generation and claim after disposal', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); driver.close();
  const before = f.counts().requests; f.reset();
  await assert.rejects(driver.authority(noop, signal()), { code: 'SCHOOL_SESSION_CHANGED' });
  await assert.rejects(driver.readFresh(noop, signal()), { code: 'SCHOOL_SESSION_CHANGED' });
  assert.equal(f.counts().requests, before);
  const g = await fixture(), other = await g.sessions.prepare(context, noop, signal()); other.close();
  const revoked = async () => { throw new Error('claim-revoked'); };
  await assert.rejects(other.authority(revoked, signal()), /claim-revoked/);
  await assert.rejects(other.readFresh(revoked, signal()), /claim-revoked/); assert.equal(g.counts().reports, 0);
});
test('anonymous media preparation retains the exact content and rechecks current authority', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
  const media = await driver.prepareMedia(noop, signal());
  assert.match(media.mediaUrl, /\/synthetic-video\/contents\/media_files\/mobile\/video\.mp4$/);
  assert.equal(f.counts().requests, 9); assert.equal(f.counts().reports, 0);
  f.reset(); await assert.rejects(media.validate(), { code: 'SCHOOL_SESSION_CHANGED' }); driver.close();
});
test('media preparation suppresses a response arriving after a new login', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
  f.onReturn(async () => { if (f.counts().requests > 7) f.reset(); });
  await assert.rejects(driver.prepareMedia(noop, signal()), { code: 'SCHOOL_SESSION_CHANGED' });
  assert.equal(f.counts().reports, 0); driver.close();
});
test('post-disposal fresh reads reject changed targets and lost cookie-jar CAS', async () => {
  for (const mode of ['type','cas']) {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); driver.close();
    if (mode === 'type') f.setType('movie'); else f.setCas(false);
    await assert.rejects(driver.readFresh(noop, signal())); assert.equal(f.counts().reports, 0);
  }
});


test('an update before playing is diagnosed as an unsent initial-event failure after fresh reads', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
  driver.observe({ ...observation, paused: true }); driver.observe(observation);
  await assert.rejects(driver.report('update', noop, signal()), error => {
    assert.deepEqual(videoReportDiagnostic(error), { stage: 'manual_event', code: 'unsupported', mayHaveWritten: false,
      context: { event: 'update', controllerPhase: 'ready', controllerAttempt: 'none', observationState: 'playing', positionDelta: 'unchanged' } });
    return true;
  });
  assert.equal(f.counts().requests, 14); assert.equal(f.counts().reports, 0); driver.close();
});

test('a paused observation arriving during fresh reads is distinguished from an unsupported launch', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
  driver.observe(observation); f.onReturn(async () => driver.observe({ ...observation, paused: true }));
  await assert.rejects(driver.report('playing', noop, signal()), error => {
    assert.deepEqual(videoReportDiagnostic(error), { stage: 'manual_event', code: 'unsupported', mayHaveWritten: false,
      context: { event: 'playing', controllerPhase: 'ready', controllerAttempt: 'none', observationState: 'paused', positionDelta: 'unchanged' } });
    return true;
  });
  assert.equal(f.counts().reports, 0); driver.close();
});

test('session, identity, enrollment, launch, target and baseline failures remain unsent with distinct stages', async () => {
  for (const stage of ['session', 'identity', 'enrollment', 'launch', 'target', 'baseline']) {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); driver.observe(observation);
    if (stage === 'session') f.reset();
    if (stage === 'identity') f.setProfile(false);
    if (stage === 'enrollment') f.setOwned(false);
    if (stage === 'launch') f.setDetails({ opened: false });
    if (stage === 'target') f.setType('movie');
    if (stage === 'baseline') f.setProgress(1);
    await assert.rejects(driver.report('playing', noop, signal()), error => {
      const diagnostic = videoReportDiagnostic(error); assert.equal(diagnostic.stage, stage); assert.equal(diagnostic.mayHaveWritten, false);
      assert.doesNotMatch(JSON.stringify(diagnostic), /synthetic|https|90000001|token|courseId|contentId/); return true;
    });
    assert.equal(f.counts().reports, 0); driver.close();
  }
});

test('a jar CAS failure after the school report retains possible-write evidence', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); driver.observe(observation); f.setCas(false);
  await assert.rejects(driver.report('playing', noop, signal()), error => {
    const diagnostic = videoReportDiagnostic(error);
    assert.equal(diagnostic.stage, 'post_report'); assert.equal(diagnostic.code, 'SCHOOL_SESSION_CHANGED'); assert.equal(diagnostic.mayHaveWritten, true); return true;
  });
  assert.equal(f.counts().reports, 1); driver.close();
});

test('the swallowed transmission failure retains its fixed cause without changing the unknown result', async () => {
  for (const [status,code] of [[200,'unexpected_response'],[401,'authentication_required'],[500,'upstream_unavailable']] as const) {
    const f=await fixture(), driver=await f.sessions.prepare(context,noop,signal());driver.observe(observation);f.setAck(false);f.setReportStatus(status);
    const result=await driver.report('playing',noop,signal());assert.equal(result.transport,'unknown');assert.equal(result.state,'closed');
    const diagnostic=postReportDiagnostic(result,'transport_unknown');
    assert.deepEqual(diagnostic.outcome,{reason:'transport_unknown',transport:'unknown',controllerPhase:'closed',transmissionCode:code,
      publishedStillTrue:true,openedStillTrue:true,omitProgressStillFalse:true,durationExactlyMatches:true,
      ...(status === 200 ? {responseFailure:'ack_result_rejected'} : {})});
    assert.equal(f.counts().reports,1);await assert.rejects(driver.report('playing',noop,signal()));assert.equal(f.counts().reports,1);
    assert.doesNotMatch(JSON.stringify(result),/outcome|transmissionCode/);driver.close();
  }
});

test('acknowledged closed reports preserve each fresh school condition and exact duration mismatch', async () => {
  for(const condition of ['published','opened','omitProgress','duration'] as const){
    const f=await fixture(), driver=await f.sessions.prepare(context,noop,signal());driver.observe(observation);
    f.onReturn(async()=>{if(f.counts().reports===1)f.setDetails(condition==='duration'
      ?{item_content_data:{content_type:'mp4',content_id:'synthetic-video',duration:600.0000000000001}}
      :{[condition==='omitProgress'?'omit_progress':condition]:condition==='omitProgress'});});
    const result=await driver.report('playing',noop,signal());assert.equal(result.transport,'acknowledged');assert.equal(result.state,'closed');
    assert.deepEqual(postReportDiagnostic(result,'nonterminal_controller_closed').outcome,{
      reason:'nonterminal_controller_closed',transport:'acknowledged',controllerPhase:'closed',transmissionCode:'none',
      publishedStillTrue:condition!=='published',openedStillTrue:condition!=='opened',omitProgressStillFalse:condition!=='omitProgress',durationExactlyMatches:condition!=='duration'});
    assert.equal(f.counts().reports,1);assert.equal(result.school.recognized,null);driver.close();
  }
});

test('real SDK package carries header, schema and rejection distinctions into private worker outcome facts', async () => {
  const cases=[
    {kind:'content_type',response:()=>new Response('private-html',{headers:{'content-type':'text/html'}})},
    {kind:'ack_schema',response:(callback:string)=>new Response(callback+'({"result":true});',{headers:{'content-type':'text/javascript'}})},
    {kind:'ack_result_rejected',response:(callback:string)=>new Response(callback+'({"result":false,"error_code":"private-rejection"});',{headers:{'content-type':'text/javascript'}})},
    {kind:'ack_error_code',response:(callback:string)=>new Response(callback+'({"result":true,"error_code":"private-rejection"});',{headers:{'content-type':'text/javascript'}})},
    {kind:'ack_invalid_playback_rate',response:(callback:string)=>new Response(callback+'({"result":false,"error_code":"INVALIDPBRate"});',{headers:{'content-type':'text/javascript'}})},
  ] as const;
  for(const sample of cases){
    const f=await fixture(), driver=await f.sessions.prepare(context,noop,signal());driver.observe(observation);f.setReportResponse(sample.response);
    const result=await driver.report('playing',noop,signal());assert.equal(result.transport,'unknown');assert.equal(result.state,'closed');
    const diagnostic=postReportDiagnostic(result,'transport_unknown');assert.equal(diagnostic.outcome?.responseFailure,sample.kind);
    assert.equal(diagnostic.outcome?.transmissionCode,'unexpected_response');assert.equal(f.counts().reports,1);
    assert.doesNotMatch(JSON.stringify(diagnostic),/private|"error_code"|https|jQuery|userId|contentId/);
    assert.doesNotMatch(JSON.stringify(result),/responseFailure|outcome/);
    await assert.rejects(driver.report('playing',noop,signal()));assert.equal(f.counts().reports,1);driver.close();
  }
});
