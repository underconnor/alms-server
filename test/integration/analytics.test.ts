import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {PgStore} from '../../src/store.js';
import {PgAnalyticsStore} from '../../src/analytics-store.js';
import {captureEvent,ANALYTICS_MONTHLY_ATTEMPT_LIMIT} from '../../src/analytics.js';
import {deliverAnalytics} from '../../src/analytics-worker.js';
import {buildApp} from '../../src/app.js';
import {loadConfig} from '../../src/config.js';
import {migrate} from '../../src/migrations.js';
import type {Session} from '../../src/domain.js';
import schema from '../../src/contracts/ux-events.schema.json' with {type:'json'};
const databaseUrl=process.env.TEST_DATABASE_URL;
if(databaseUrl&&!['/alms_test','/alms_qa'].includes(new URL(databaseUrl).pathname))throw new Error('Use an isolated alms_test or alms_qa database');
const event=(index=0)=>({...structuredClone(schema.examples[index]!),event_id:randomUUID(),occurred_minute:new Date(Math.floor(Date.now()/60000)*60000).toISOString().replace('.000Z','Z')});

describe('PostgreSQL durable analytics with anonymous synthetic behavior events',{skip:!databaseUrl},()=>{
  let pool:Pool,store:PgStore,app:FastifyInstance;
  let a:Awaited<ReturnType<PgStore['issueVerifiedSession']>>,b:typeof a;
  let initialBudget:number|null=null;
  const headers=(session:typeof a)=>({cookie:'__Host-alms_session='+session.token,origin:'https://lms.flyjung.kr','x-csrf-token':session.csrfToken});
  const auth=async(value:typeof a)=>(await store.getSession((await import('../../src/store.js')).hashToken(value.token)))!;
  const submit=(input:unknown,owner=a)=>app.inject({method:'POST',url:'/v1/analytics/events',headers:headers(owner),payload:input as Record<string,unknown>});
  before(async()=>{
    pool=new Pool({connectionString:databaseUrl,max:10});await migrate(pool);await migrate(pool);store=new PgStore(pool);
    const count=(await pool.query('SELECT count(*)::int AS count FROM analytics_events')).rows[0].count;
    assert.equal(count,0,'Use an isolated analytics test database with no pre-existing events');
    const budget=(await pool.query("SELECT attempts FROM analytics_delivery_budget WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date")).rows[0];
    initialBudget=budget?.attempts??null;
    a=await store.issueVerifiedSession({provider:'analytics-integration',subject:randomUUID()},3600);
    b=await store.issueVerifiedSession({provider:'analytics-integration',subject:randomUUID()},3600);
    app=await buildApp(loadConfig({DATABASE_URL:databaseUrl,LOG_LEVEL:'silent'}),store);
  });
  beforeEach(async()=>{
    await pool.query('DELETE FROM analytics_events WHERE user_id=ANY($1::uuid[])',[[a.user.id,b.user.id]]);
    await pool.query("INSERT INTO analytics_delivery_budget(month,attempts) VALUES(date_trunc('month',now() AT TIME ZONE 'UTC')::date,0) ON CONFLICT(month) DO UPDATE SET attempts=0");
  });
  after(async()=>{
    if(app)await app.close();
    if(pool){
      if(a&&b)await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[a.user.id,b.user.id]]);
      if(initialBudget===null)await pool.query("DELETE FROM analytics_delivery_budget WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date");
      else await pool.query("UPDATE analytics_delivery_budget SET attempts=$1 WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date",[initialBudget]);
      await pool.end();
    }
  });
  it('persists before 202 with no key or opt-in and exposes only owner-scoped aggregates',async()=>{
    const input=event();
    assert.equal((await app.inject({method:'POST',url:'/v1/analytics/events',payload:input})).statusCode,401);
    assert.equal((await app.inject('/v1/analytics/summary')).statusCode,401);
    for(const badHeaders of [{cookie:headers(a).cookie},{...headers(a),origin:'https://invalid.example'}]){
      assert.equal((await app.inject({method:'POST',url:'/v1/analytics/events',headers:badHeaders,payload:input})).statusCode,403);
    }
    const response=await submit(input);assert.equal(response.statusCode,202);assert.deepEqual(response.json(),{accepted:true,reason:'stored'});
    const stored=(await pool.query('SELECT payload,delivery_uuid FROM analytics_events WHERE user_id=$1',[a.user.id])).rows[0];
    const current=await auth(a);
    assert.equal(stored.payload.analyticsId,current.user.analyticsId);assert.equal(stored.payload.sessionId,current.analyticsSessionId);
    assert.notEqual(stored.payload.analyticsId,input.analytics_id);assert.equal((await pool.query('SELECT * FROM analytics_delivery WHERE delivery_uuid=$1',[stored.delivery_uuid])).rowCount,1);
    const me=(await app.inject({url:'/v1/me',headers:headers(a)})).json();
    assert.equal(me.analytics.enabled,true);assert.equal(me.analytics.collection,'required');assert.equal(me.analytics.delivery,'local');assert.equal(me.analytics.configured,false);
    const summary=(await app.inject({url:'/v1/analytics/summary?days=7',headers:headers(a)})).json();
    assert.equal(summary.totals.events,1);assert.equal(summary.delivery.pending,1);assert.equal(summary.delivery.sent,0);assert.equal(summary.delivery.destination,'local');
    assert.equal((await app.inject({url:'/v1/analytics/summary',headers:headers(b)})).json().totals.events,0);
    for(const query of ['userId='+a.user.id,'days=366','days=0','days=7&days=8'])assert.equal((await app.inject({url:'/v1/analytics/summary?'+query,headers:headers(b)})).statusCode,400);
    assert.doesNotMatch(JSON.stringify(summary),new RegExp([a.user.id,a.user.analyticsId,current.analyticsSessionId,input.event_id].join('|')));
    assert.equal((await app.inject({method:'PATCH',url:'/v1/me/preferences',headers:headers(a),payload:{analyticsEnabled:false}})).statusCode,409);
  });
  it('deduplicates concurrent owner retries without exposing another owner event ID',async()=>{
    const input=event();
    const results=await Promise.all([submit(input),submit(input)]);
    assert.deepEqual(results.map(value=>value.json().reason).sort(),['duplicate','stored']);
    assert.equal((await pool.query('SELECT * FROM analytics_events')).rowCount,1);
    assert.equal((await submit(input,b)).json().reason,'stored');
    assert.equal((await pool.query('SELECT count(DISTINCT delivery_uuid)::int AS count FROM analytics_events')).rows[0].count,2);
    assert.equal((await submit({...input,screen:'settings'})).statusCode,409);
    assert.equal((await pool.query('SELECT * FROM analytics_delivery')).rowCount,2);
  });
  it('rejects private fields and out-of-range clocks before storing',async()=>{
    for(const input of [{...event(),studentId:'not-allowed'},{...event(),properties:{url:'https://invalid.example'}},{...event(),occurred_minute:'2000-01-01T00:00:00Z'}])assert.equal((await submit(input)).statusCode,400);
    assert.equal((await pool.query('SELECT * FROM analytics_events')).rowCount,0);
  });
  it('enforces a per-owner limit atomically and duplicate retries do not consume it',async()=>{
    const user=await auth(a),first=event();await captureEvent(first,user,store.analytics);
    // Prepare 119 synthetic receipts at one database timestamp. Sequentially sending
    // 120 events can take over a minute on a remote QA database and legitimately
    // expire the first receipts from the rolling window before the assertion.
    const seeded=await pool.query(`WITH first_receipt AS (
      UPDATE analytics_events SET received_at=now() WHERE user_id=$1 AND event_id=$2
      RETURNING user_id,occurred_at,payload
    ), synthetic AS (
      SELECT user_id,occurred_at,payload,gen_random_uuid() AS event_id,gen_random_uuid() AS delivery_uuid
      FROM first_receipt CROSS JOIN generate_series(1,118)
    ), inserted AS (
      INSERT INTO analytics_events(user_id,event_id,delivery_uuid,occurred_at,received_at,payload)
      SELECT user_id,event_id,delivery_uuid,occurred_at,now(),jsonb_set(payload,'{eventId}',to_jsonb(event_id::text)) FROM synthetic
      RETURNING delivery_uuid
    ) INSERT INTO analytics_delivery(delivery_uuid) SELECT delivery_uuid FROM inserted`,[a.user.id,first.event_id]);
    assert.equal(seeded.rowCount,118);
    // Both real writes compete for the final slot: the owner lock must admit one.
    const results=await Promise.allSettled([
      captureEvent(event(),user,store.analytics),captureEvent(event(),user,store.analytics),
    ]);
    const stored=results.filter(result=>result.status==='fulfilled');
    const rejected=results.filter(result=>result.status==='rejected');
    assert.equal(stored.length,1);assert.equal(stored[0]!.value.reason,'stored');
    assert.equal(rejected.length,1);assert.equal(rejected[0]!.reason.statusCode,429);
    assert.equal((await captureEvent(first,user,store.analytics)).reason,'duplicate');
    assert.equal((await captureEvent(event(),await auth(b),store.analytics)).reason,'stored');
    assert.equal((await pool.query('SELECT * FROM analytics_events')).rowCount,121);
    assert.equal((await pool.query('SELECT * FROM analytics_delivery')).rowCount,121);
  });
  it('aggregates actual durations, buttons, categories and normalized errors',async()=>{
    for(const milliseconds of [100,500]){
      const input=event(3);Object.assign(input.properties,{duration_ms:milliseconds});await submit(input);
    }
    for(const index of [1,2,4])await submit(event(index));
    const summary=await store.analytics.summarize(a.user.id,7);
    assert.equal(summary.totals.events,5);assert.equal(summary.totals.sessions,1);
    assert.deepEqual(summary.durations,[{operation:'navigate_course',outcome:'ui_shown',count:2,averageMs:300,p95Ms:480}]);
    assert.equal(summary.buttons[0]!.action,'run_now');assert.equal(summary.categories[0]!.selected,'assignments');assert.equal(summary.errors[0]!.code,'school_fetch_failed');
  });
  it('groups trusted frontend sessions and release versions without exposing a raw user or event identifier', async () => {
    const first = { ...await auth(a), clientId: 'alms-web' }, second = { ...await auth(a), clientId: 'alms-next' };
    await captureEvent({ ...event(), ui_version: 'desktop-v43' }, first, store.analytics);
    await captureEvent({ ...event(), ui_version: 'desktop-v43' }, second, store.analytics);
    await captureEvent({ ...event(), ui_version: 'desktop-v44' }, second, store.analytics);
    await captureEvent({ ...event(), ui_version: 'desktop-v43' }, { ...await auth(b), clientId: 'other-ui' }, store.analytics);
    const summary = await store.analytics.summarize(a.user.id, 7);
    assert.deepEqual(summary.frontends, [
      { clientId: 'alms-next', uiVersion: 'desktop-v43', count: 1 }, { clientId: 'alms-next', uiVersion: 'desktop-v44', count: 1 },
      { clientId: 'alms-web', uiVersion: 'desktop-v43', count: 1 },
    ]);
    assert.doesNotMatch(JSON.stringify(summary.frontends), new RegExp([a.user.id, first.analyticsSessionId, 'other-ui'].join('|')));
    for (const invalid of [null, 123, '', 'UPPERCASE', 'x'.repeat(65)]) {
      await assert.rejects(pool.query('UPDATE analytics_events SET payload=payload || $1::jsonb WHERE user_id=$2',
        [JSON.stringify({clientId: invalid}), a.user.id]), {code: '23514'});
    }
    await assert.rejects(pool.query('UPDATE analytics_events SET payload=payload || $1::jsonb WHERE user_id=$2',
      [JSON.stringify({privateSubject: 'synthetic-only'}), a.user.id]), {code: '23514'});
    assert.deepEqual((await store.analytics.summarize(a.user.id, 7)).frontends, summary.frontends);
  });
  it('leases once, retries after failure and preserves provider UUID across crash recovery',async()=>{
    await submit(event());
    assert.deepEqual(await deliverAnalytics(store.analytics),{attempted:0,sent:0});
    const claims=await Promise.all([store.analytics.claim(),store.analytics.claim()]);assert.equal(claims[0]!.length+claims[1]!.length,1);
    const lease=[...claims[0]!,...claims[1]!][0]!;
    assert.equal(await store.analytics.finish(lease,'network_unavailable'),true);
    assert.equal((await store.analytics.claim()).length,0);
    await pool.query("UPDATE analytics_delivery SET next_attempt_at=now()-interval '1 second'");
    const retry=(await store.analytics.claim())[0]!;assert.equal(retry.uuid,lease.uuid);assert.notEqual(retry.token,lease.token);
    assert.equal(await store.analytics.finish(lease,null),false);
    await pool.query("UPDATE analytics_delivery SET lease_until=now()-interval '1 second'");
    const recovered=(await store.analytics.claim())[0]!;assert.equal(recovered.uuid,lease.uuid);assert.equal(recovered.attempts,3);
    assert.equal(await store.analytics.finish(recovered,null),true);assert.equal((await store.analytics.claim()).length,0);
    const summary=await store.analytics.summarize(a.user.id,7);assert.equal(summary.delivery.sent,1);assert.equal(summary.delivery.pending,0);
  });
  it('monthly attempt cap preserves stored events and prevents extra provider claims',async()=>{
    await submit(event());await submit(event());
    await pool.query("UPDATE analytics_delivery_budget SET attempts=$1 WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date",[ANALYTICS_MONTHLY_ATTEMPT_LIMIT-1]);
    assert.equal((await store.analytics.claim()).length,1);assert.equal((await store.analytics.claim()).length,0);
    assert.equal((await store.analytics.deliveryBudget()).attempts,ANALYTICS_MONTHLY_ATTEMPT_LIMIT);
    assert.equal((await store.analytics.summarize(a.user.id,7)).totals.events,2);
  });
  it('retention deletes expired payload and outbox together while keeping recent data',async()=>{
    const expired=event();await submit(expired);await submit(event());
    await pool.query("UPDATE analytics_events SET occurred_at=now()-interval '366 days' WHERE user_id=$1 AND event_id=$2",[a.user.id,expired.event_id]);
    assert.equal(await store.analytics.prune(),1);assert.equal((await pool.query('SELECT * FROM analytics_events')).rowCount,1);assert.equal((await pool.query('SELECT * FROM analytics_delivery')).rowCount,1);
  });
});
