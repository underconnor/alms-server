import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { captureEvent, projectStoredEvent, type AnalyticsEvent } from '../src/analytics.js';
import { deliverAnalytics } from '../src/analytics-worker.js';
import type { AnalyticsRepository, DeliveryLease } from '../src/analytics-store.js';
import { AppError } from '../src/errors.js';
import type { Session } from '../src/domain.js';
import schema from '../src/contracts/ux-events.schema.json' with {type:'json'};
const event=()=>({...structuredClone(schema.examples[0]!),event_id:randomUUID(),occurred_minute:new Date(Math.floor(Date.now()/60000)*60000).toISOString().replace('.000Z','Z')});
const session=()=>({user:{id:randomUUID(),analyticsId:randomUUID(),analyticsEnabled:false},analyticsSessionId:randomUUID()} as Session);

test('required collection stores the allowlisted event with server identity before acknowledging',async()=>{
  const input=event(),auth=session(); let stored:AnalyticsEvent|undefined;
  const repository={persist:async(owner:string,value:AnalyticsEvent)=>{assert.equal(owner,auth.user.id);stored=value;return 'stored';}} as AnalyticsRepository;
  assert.deepEqual(await captureEvent(input,auth,repository),{accepted:true,reason:'stored'});
  assert.equal(stored!.analyticsId,auth.user.analyticsId); assert.equal(stored!.sessionId,auth.analyticsSessionId);
  assert.notEqual(stored!.analyticsId,input.analytics_id);
  assert.doesNotMatch(JSON.stringify(stored),/userId|studentId|displayName|token|https:|cookie|referrer/);
  const failure={persist:async()=>{throw new Error('database unavailable');}} as unknown as AnalyticsRepository;
  await assert.rejects(captureEvent(input,auth,failure),/database unavailable/);
});

test('registered frontend identity comes from the server session and a bounded release label reaches storage and delivery', async () => {
  const auth = { ...session(), clientId: 'alms-new-ui' }; let stored!: AnalyticsEvent;
  const repository = { persist: async (_owner: string, value: AnalyticsEvent) => { stored = value; return 'stored'; } } as AnalyticsRepository;
  const input = { ...event(), ui_version: 'desktop-2026.10.14' };
  await captureEvent(input, auth, repository);
  assert.equal(stored.clientId, 'alms-new-ui'); assert.equal(stored.uiVersion, 'desktop-2026.10.14');
  const projected = projectStoredEvent(stored);
  assert.equal(projected.properties.client_id, 'alms-new-ui'); assert.equal(projected.properties.ui_version, input.ui_version);
  for (const invalid of [
    { ...input, client_id: 'forged-ui' }, { ...input, clientId: 'forged-ui' },
    ...['', 'x'.repeat(65), 'https://private.invalid', 'has whitespace', 'line\nbreak'].map(ui_version => ({ ...input, ui_version })),
  ]) await assert.rejects(captureEvent(invalid, auth, repository), { code: 'INVALID_EVENT' });
  assert.doesNotMatch(JSON.stringify(projected), /studentId|displayName|https:|token|cookie/);
});

test('private fields, arbitrary enum values, old and far future events never reach persistence',async()=>{
  let writes=0;
  const repository={persist:async()=>{writes++;return 'stored';}} as unknown as AnalyticsRepository;
  const input=event(),auth=session();
  for(const invalid of [
    {...input,url:'https://invalid.example/private'},
    {...input,properties:{name:'private'}},
    {...input,event_name:'arbitrary-text'},
    {...input,screen:'arbitrary-screen'},
    {...input,occurred_minute:'2000-01-01T00:00:00Z'},
    {...input,occurred_minute:'2099-01-01T00:00:00Z'},
  ])await assert.rejects(captureEvent(invalid,auth,repository),error=>error instanceof AppError&&error.statusCode===400);
  assert.equal(writes,0);
});

test('no provider key leaves durable events queued without claiming or sending',async()=>{
  const repository={claim:async()=>{throw new Error('must not claim');}} as unknown as AnalyticsRepository;
  const send=(async()=>{throw new Error('must not send');}) as typeof fetch;
  assert.deepEqual(await deliverAnalytics(repository,undefined,send),{attempted:0,sent:0});
});

test('EU delivery retries use a stable UUID and store only normalized errors, never response bodies',async()=>{
  const input=event(),auth=session();let stored!:AnalyticsEvent;
  await captureEvent(input,auth,{persist:async(_id:string,value:AnalyticsEvent)=>{stored=value;return 'stored';}} as AnalyticsRepository);
  const lease:DeliveryLease={uuid:randomUUID(),token:randomUUID(),attempts:1,event:stored};
  const outcomes:unknown[]=[];const bodies:Record<string,any>[]=[];
  const repository={claim:async(limit:number)=>{assert.equal(limit,10);return [lease];},finish:async(_lease:DeliveryLease,error:unknown)=>{outcomes.push(error);return true;}} as unknown as AnalyticsRepository;
  const send=(async(url:string,init:RequestInit)=>{
    assert.equal(url,'https://eu.i.posthog.com/i/v0/e/');assert.equal(init.redirect,'error');
    assert.deepEqual(init.headers,{'content-type':'application/json'});assert.ok(init.signal instanceof AbortSignal);
    const body=JSON.parse(String(init.body));bodies.push(body);
    assert.deepEqual(Object.keys(body).sort(),['api_key','distinct_id','event','properties','timestamp','uuid']);
    assert.equal(body.properties.$geoip_disable,true);assert.equal(body.properties.$process_person_profile,false);
    assert.doesNotMatch(String(init.body),/student|cookie|authorization|https:|referrer/);
    return new Response('private-provider-body',{status:bodies.length===1?503:200});
  }) as typeof fetch;
  assert.deepEqual(await deliverAnalytics(repository,'synthetic-key',send),{attempted:1,sent:0});
  assert.deepEqual(await deliverAnalytics(repository,'synthetic-key',send),{attempted:1,sent:1});
  assert.deepEqual(outcomes,['provider_rejected',null]);assert.equal(bodies[0]!.uuid,bodies[1]!.uuid);
  await deliverAnalytics(repository,'synthetic-key',(async()=>{throw new Error('private-network-detail');}) as typeof fetch);
  assert.equal(outcomes[2],'network_unavailable');
});

test('delivery waits for every claimed item before reporting a persistence failure',async()=>{
  let completed=false;
  const leases=[1,2].map(i=>({uuid:String(i),token:'lease',attempts:1,event:{eventName:'page_view',properties:{}}} as DeliveryLease));
  const repository={claim:async()=>leases,finish:async(lease:DeliveryLease)=>{
    if(lease.uuid==='1')throw new Error('database unavailable');
    await new Promise(resolve=>setTimeout(resolve,10));completed=true;return true;
  }} as unknown as AnalyticsRepository;
  await assert.rejects(deliverAnalytics(repository,'synthetic-key',(async()=>new Response('{}')) as typeof fetch),/persistence failed/);
  assert.equal(completed,true);
});

test('syllabus tab analytics accept only the fixed category without report content', async () => {
  const input = { ...event(), event_name: 'category_select', screen: 'course', properties: {
    group: 'course_tab', previous: 'weeks', selected: 'syllabus', selection_source: 'tab_click', interaction: 'user_explicit',
  } };
  let stored: AnalyticsEvent | undefined;
  const repository = { persist: async (_owner: string, value: AnalyticsEvent) => { stored = value; return 'stored'; } } as AnalyticsRepository;
  await captureEvent(input, session(), repository);
  assert.equal(stored?.properties.selected, 'syllabus');
  await assert.rejects(captureEvent({ ...input, properties: { ...input.properties, documentVersion: 'a'.repeat(64) } }, session(), repository));
});

test('calendar actions and load operation persist only fixed enums without calendar content or identifiers', async () => {
  const auth = session(), stored: AnalyticsEvent[] = [];
  const repository = { persist: async (_owner: string, value: AnalyticsEvent) => { stored.push(value); return 'stored'; } } as AnalyticsRepository;
  const actions = ['show_task_list', 'show_calendar', 'calendar_previous_month', 'calendar_next_month', 'calendar_today',
    'calendar_select_course', 'calendar_select_day', 'open_calendar_entry'];
  for (const action of actions) await captureEvent({ ...event(), event_name: 'button_click', screen: 'tasks',
    properties: { action, surface: 'tasks_detail' } }, auth, repository);
  for (const [event_name, properties] of [
    ['interaction_duration', { operation: 'load_calendar', duration_ms: 100, outcome: 'ui_shown' }],
    ['normalized_error', { operation: 'load_calendar', code: 'school_fetch_failed', retryable: true }],
  ]) await captureEvent({ ...event(), event_name, screen: 'tasks', properties }, auth, repository);
  assert.equal(stored.length, 10);
  const base = { ...event(), event_name: 'button_click', screen: 'tasks', properties: { action: 'open_calendar_entry', surface: 'tasks_detail' } };
  for (const field of ['month', 'day', 'start', 'end', 'courseId', 'eventId', 'title', 'description', 'url'])
    await assert.rejects(captureEvent({ ...base, properties: { ...base.properties, [field]: 'private-calendar-value' } }, auth, repository),
      error => error instanceof AppError && error.code === 'INVALID_EVENT');
  assert.equal(stored.length, 10);
  assert.doesNotMatch(JSON.stringify(stored.map(value => value.properties)), /private-calendar|courseId|eventId|description|url/);
});

test('unchanged worker projection forwards accepted calendar enums without new content fields or schema dependency', async () => {
  const auth = session(); let stored!: AnalyticsEvent;
  await captureEvent({ ...event(), event_name: 'button_click', screen: 'tasks',
    properties: { action: 'calendar_select_course', surface: 'tasks_detail' } }, auth,
  { persist: async (_owner: string, value: AnalyticsEvent) => { stored = value; return 'stored'; } } as AnalyticsRepository);
  const lease: DeliveryLease = { uuid: randomUUID(), token: randomUUID(), attempts: 1, event: stored };
  const repository = { claim: async () => [lease], finish: async () => true } as unknown as AnalyticsRepository;
  const send = (async (_url: string, init: RequestInit) => {
    const output = JSON.parse(String(init.body));
    assert.equal(output.event, 'alms_button_click');
    assert.deepEqual(output.properties.details, { action: 'calendar_select_course', surface: 'tasks_detail' });
    assert.deepEqual(Object.keys(output.properties).sort(), ['$geoip_disable', '$process_person_profile', 'details', 'event_id',
      'schema_version', 'screen', 'session_id', 'session_sequence', 'ui_version']);
    assert.doesNotMatch(JSON.stringify(output), /courseId|eventId|description|calendar\?start|https:/);
    return new Response('{}');
  }) as typeof fetch;
  assert.deepEqual(await deliverAnalytics(repository, 'synthetic-key', send), { attempted: 1, sent: 1 });
});

test('course year and term selection records fixed actions without the chosen identifiers', async () => {
  const auth = session(), stored: AnalyticsEvent[] = [];
  const repository = { persist: async (_owner: string, value: AnalyticsEvent) => { stored.push(value); return 'stored'; } } as AnalyticsRepository;
  for (const action of ['select_course_year', 'select_course_term']) {
    const value = { ...event(), event_name: 'button_click', screen: 'courses', properties: { action, surface: 'course_header' } };
    await captureEvent(value, auth, repository);
    for (const field of ['year', 'termId', 'termName', 'courseId'])
      await assert.rejects(captureEvent({ ...value, properties: { ...value.properties, [field]: 'private-academic-value' } }, auth, repository),
        { code: 'INVALID_EVENT' });
  }
  assert.equal(stored.length, 2);
  assert.doesNotMatch(JSON.stringify(stored.map(value => value.properties)), /private-academic|termId|termName|courseId/);
});

test('personal completion actions and timing/errors persist fixed behavior only and reject private learning fields', async () => {
  const auth = session(), stored: AnalyticsEvent[] = [];
  const repository = { persist: async (_owner: string, value: AnalyticsEvent) => { stored.push(value); return 'stored'; } } as AnalyticsRepository;
  const accepted = [
    ...['set_learning_complete', 'set_learning_incomplete', 'reset_learning_completion'].map(action => ({
      ...event(), event_name: 'button_click', screen: 'course', properties: { action, surface: 'course_row' },
    })),
    ...['load_learning_completion', 'save_learning_completion'].flatMap(operation => [
      { ...event(), event_name: 'interaction_duration', screen: 'course', properties: { operation, duration_ms: 100, outcome: 'ui_shown' } },
      { ...event(), event_name: 'normalized_error', screen: 'course', properties: { operation, code: 'network_unavailable', retryable: true } },
    ]),
  ];
  for (const input of accepted) {
    await captureEvent(input, auth, repository);
    for (const field of ['courseId', 'activityId', 'studentId', 'title', 'body', 'url', 'sourceUrl'])
      await assert.rejects(captureEvent({ ...input, properties: { ...input.properties, [field]: 'private-learning-value' } }, auth, repository),
        { code: 'INVALID_EVENT' });
  }
  assert.equal(stored.length, 7);
  assert.deepEqual(stored.slice(0, 3).map(value => value.properties.action), ['set_learning_complete', 'set_learning_incomplete', 'reset_learning_completion']);
  assert.doesNotMatch(JSON.stringify(stored.map(value => value.properties)), /private-learning|courseId|activityId|studentId|title|body|url|sourceUrl/);
});
