import { before,after,describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../src/migrations.js';
import { createPlaybackAdmission } from '../../src/playback-authority.js';
import { PgStore,hashToken } from '../../src/store.js';
import { PgPlaybackLeaseRepository,type PlaybackLeaseScope } from '../../src/manual-video-lease.js';
const url=process.env.TEST_DATABASE_URL;
if(url&&!['/alms_test','/alms_qa'].includes(new URL(url).pathname))throw new Error('Use isolated test database');
describe('manual and worker execution leases in isolated PostgreSQL',{skip:!url},()=>{
 let pool:Pool,store:PgStore,repo:PgPlaybackLeaseRepository;const owners:string[]=[];
 const signal=()=>AbortSignal.timeout(5000);
 async function fixture(){const raw='synthetic-sealed-'+randomUUID(),identity={provider:'manual-lease-qa',subject:randomUUID()};const s=await store.issueVerifiedSession(identity,3600,{provider:'ssu',seal:()=>raw});owners.push(s.user.id);
  const scope:PlaybackLeaseScope={owner:s.user.id,generation:randomUUID(),courseId:'10',moduleItemId:'20',tokenHash:randomBytes(32).toString('hex'),kind:'manual'};
  return {scope,identity,auth:{encryptedSession:raw,almsTokenHash:hashToken(s.token)}};
 }
 async function loginAgain(identity:{provider:string;subject:string},scope:PlaybackLeaseScope){
  const raw='synthetic-new-generation-'+randomUUID(),session=await store.issueVerifiedSession(identity,3600,{provider:'ssu',seal:()=>raw});
  assert.equal(session.user.id,scope.owner);
  return {scope:{...scope,generation:randomUUID(),tokenHash:randomBytes(32).toString('hex')},auth:{encryptedSession:raw,almsTokenHash:hashToken(session.token)}};
 }
 async function workerScope(scope:PlaybackLeaseScope,auth:{encryptedSession:string;almsTokenHash:string}){
  const job=await store.createJob(scope.owner,{courseId:scope.courseId,lectureId:scope.moduleItemId,scheduledFor:new Date().toISOString(),idempotencyKey:randomUUID(),requestHash:'synthetic-worker-lease'},
   {admission:createPlaybackAdmission({userId:scope.owner,courseId:scope.courseId,lectureId:scope.moduleItemId},{generation:scope.generation,encryptedSession:auth.encryptedSession}),almsTokenHash:auth.almsTokenHash});
  const claimed=await store.claimJob(job.id);assert.ok(claimed?.executionTokenHash);
  return {...scope,kind:'worker' as const,tokenHash:claimed.executionTokenHash};
 }
 before(async()=>{pool=new Pool({connectionString:url,max:10,statement_timeout:5000});await migrate(pool);store=new PgStore(pool);repo=new PgPlaybackLeaseRepository(pool);});
 after(async()=>{if(pool){await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[owners]);await pool.end();}});
 it('allows one owner lifetime across different API instances and targets',async()=>{
  const {scope,auth}=await fixture(),other=new PgPlaybackLeaseRepository(pool);
  const attempts=await Promise.all([repo.acquire(scope,auth,signal()),other.acquire({...scope,moduleItemId:'21',tokenHash:randomBytes(32).toString('hex')},auth,signal())]);assert.equal(attempts.filter(Boolean).length,1);
  assert.equal((await pool.query('SELECT 1 FROM playback_execution_leases WHERE user_id=$1',[scope.owner])).rowCount,1);
 });
 it('requires the current school seal and a live browser session for manual acquisition',async()=>{
  const {scope,auth}=await fixture();assert.equal(await repo.acquire(scope,{...auth,encryptedSession:'stale'},signal()),false);
  assert.equal(await repo.acquire(scope,{...auth,almsTokenHash:randomBytes(32).toString('hex')},signal()),false);
  const worker=await workerScope(scope,auth);
  await pool.query('DELETE FROM sessions WHERE user_id=$1',[scope.owner]);assert.equal(await repo.acquire(scope,auth,signal()),false);
  assert.equal(await repo.acquire(worker,{encryptedSession:auth.encryptedSession},signal()),true);
 });
 it('isolates renewal and release by complete owner generation target and token',async()=>{
  const {scope,auth}=await fixture(),other=await fixture();assert.equal(await repo.acquire(scope,auth,signal()),true);
  const wrong=[{...scope,owner:other.scope.owner},{...scope,generation:randomUUID()},{...scope,courseId:'11'},{...scope,moduleItemId:'21'},{...scope,tokenHash:randomBytes(32).toString('hex')},{...scope,kind:'worker' as const}];
  for(const s of wrong){assert.equal(await repo.renew(s,signal()),false);await repo.release(s,signal());}
  assert.equal(await repo.renew(scope,signal()),true);await repo.release(scope,signal());assert.equal(await repo.renew(scope,signal()),false);
 });
 it('lets expiry replace an old lease without late cleanup deleting the replacement',async()=>{
  const {scope,auth}=await fixture();await repo.acquire(scope,auth,signal());
  await pool.query("UPDATE playback_execution_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[scope.owner]);assert.equal(await repo.renew(scope,signal()),false);
  const renewed={...scope,tokenHash:randomBytes(32).toString('hex')};assert.equal(await repo.acquire(renewed,auth,signal()),true);await repo.release(scope,signal());assert.equal(await repo.renew(renewed,signal()),true);
 });
 it('a new login cannot replace an unexpired lease, including an uncertain report hold, until expiry',async()=>{
  const {scope,auth,identity}=await fixture(),other=new PgPlaybackLeaseRepository(pool);
  assert.equal(await repo.acquire(scope,auth,signal()),true);
  const before=(await pool.query('SELECT generation,token_hash,expires_at FROM playback_execution_leases WHERE user_id=$1',[scope.owner])).rows[0];
  const fresh=await loginAgain(identity,scope),worker=await workerScope(fresh.scope,fresh.auth);
  assert.equal(await repo.acquire(fresh.scope,auth,signal()),false);
  const blocked=await Promise.all([repo.acquire(fresh.scope,fresh.auth,signal()),other.acquire(worker,{encryptedSession:fresh.auth.encryptedSession},signal())]);
  assert.deepEqual(blocked,[false,false]);
  await other.release(fresh.scope,signal());
  assert.deepEqual((await pool.query('SELECT generation,token_hash,expires_at FROM playback_execution_leases WHERE user_id=$1',[scope.owner])).rows[0],before);
  await pool.query("UPDATE playback_execution_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[scope.owner]);
  const acquired=await Promise.all([repo.acquire(fresh.scope,fresh.auth,signal()),other.acquire(worker,{encryptedSession:fresh.auth.encryptedSession},signal())]);
  assert.equal(acquired.filter(Boolean).length,1);
  await repo.release(scope,signal());
  assert.equal(await repo.renew(acquired[0]?fresh.scope:worker,signal()),true);
 });
 it('a new generation acquires before expiry only after the exact existing lifetime releases',async()=>{
  const {scope,auth,identity}=await fixture();assert.equal(await repo.acquire(scope,auth,signal()),true);
  const fresh=await loginAgain(identity,scope);
  await repo.release({...scope,tokenHash:fresh.scope.tokenHash},signal());
  assert.equal(await repo.acquire(fresh.scope,fresh.auth,signal()),false);
  await repo.release(scope,signal());
  assert.equal(await repo.acquire(fresh.scope,fresh.auth,signal()),true);
  await repo.release(scope,signal());assert.equal(await repo.renew(fresh.scope,signal()),true);
 });
 it('blocks manual playback while an existing worker job is active and releases only after it stops',async()=>{
  const {scope,auth}=await fixture();const job=await store.createJob(scope.owner,{courseId:'10',lectureId:'20',scheduledFor:new Date().toISOString(),idempotencyKey:randomUUID(),requestHash:'synthetic-qa'},{admission:createPlaybackAdmission({userId:scope.owner,courseId:'10',lectureId:'20'},{generation:scope.generation,encryptedSession:auth.encryptedSession}),almsTokenHash:auth.almsTokenHash});
  for(const status of ['running','pause_requested','cancel_requested','reconciling']){await pool.query('UPDATE playback_jobs SET status=$2 WHERE id=$1',[job.id,status]);assert.equal(await repo.acquire(scope,auth,signal()),false);}
  await pool.query("UPDATE playback_jobs SET status='cancelled' WHERE id=$1",[job.id]);assert.equal(await repo.acquire(scope,auth,signal()),true);
 });
 it('does not create a lease after cancellation before transaction entry',async()=>{
  const {scope,auth}=await fixture(),abort=new AbortController();abort.abort();await assert.rejects(repo.acquire(scope,auth,abort.signal));assert.equal((await pool.query('SELECT 1 FROM playback_execution_leases WHERE user_id=$1',[scope.owner])).rowCount,0);
 });
});
