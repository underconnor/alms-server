import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../../src/migrations.js';
import { PgStore, hashToken } from '../../src/store.js';

const url=process.env.TEST_DATABASE_URL;
if(url&&!['/alms_test','/alms_qa'].includes(new URL(url).pathname))throw new Error('Use isolated test database');
test('migration020 preserves every existing fact and catalog object except the explicitly replaced blocker index',{skip:!url},async t=>{
  const schema='preplay_catalog_'+randomUUID().replaceAll('-',''),directory=await mkdtemp(join(tmpdir(),'alms-preplay-catalog-'));
  const admin=new Pool({connectionString:url,max:1});let pool:Pool|undefined;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:url,max:2,options:`-c search_path=${schema}`});
    const files=(await readdir(resolve('migrations'))).filter(name=>/^(00[1-9]|01[0-9])-.*\.sql$/.test(name)).sort();
    assert.equal(files.length,19);for(const name of files)await copyFile(resolve('migrations',name),join(directory,name));
    await migrate(pool,directory);const store=new PgStore(pool);
    await assert.rejects(store.health(),/migrations are pending/);
    const session=await store.issueVerifiedSession({provider:'preplay-catalog-qa',subject:randomUUID()},3600,{provider:'ssu',seal:()=> 'synthetic-catalog-seal'});
    await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash,
      accepted_generation,last_execution_token_hash,execution_outcome,error_code,created_at,updated_at)
      VALUES($1,$2,'10','20','needs_verification','2026-11-08T01:00:00Z',$3,$4,$5,$6,'not_started','SCHOOL_RESULT_UNKNOWN',
        '2026-11-08T01:00:00Z','2026-11-08T01:00:03.123456Z')`,[randomUUID(),session.user.id,randomUUID(),hashToken('original'),randomUUID(),hashToken('old-token')]);
    const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename<>'schema_migrations' ORDER BY tablename",[schema])).rows.map(row=>row.tablename as string);
    const histories=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await pool!.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg((to_jsonb(row)-'reviewed_preplay_release_id')::text,'' ORDER BY (to_jsonb(row)-'reviewed_preplay_release_id')::text),'')) AS hash FROM ${table} row`)).rows[0]])));
    const catalog=async()=>({
      indexes:(await pool!.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname<>'playback_active_lecture_idx' ORDER BY indexname",[schema])).rows,
      constraints:(await pool!.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
        JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,k.conname`,[schema])).rows,
      functions:(await pool!.query(`SELECT p.proname,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 ORDER BY p.proname`,[schema])).rows,
      triggers:(await pool!.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,[schema])).rows,
    });
    const spec=JSON.parse(await readFile(new URL('../helpers/playback-queue-catalog-queries.json',import.meta.url),'utf8'));
    const fullCatalog=async()=>Object.fromEntries(await Promise.all(Object.entries(spec.queries as Record<string,string>).map(async([name,sql])=>{
      const scoped=sql.replaceAll("'public'","'"+schema+"'");
      // Deployment compares public function definitions; normalize before hashing, not after JSON serialization.
      const query=name==='functions'?scoped.replace('pg_get_functiondef(p.oid)',"replace(pg_get_functiondef(p.oid),$1,'public')"):scoped;
      return [name,(await pool!.query(query,name==='functions'?[schema]:[])).rows];
    })));
    const fullBefore=await fullCatalog();
    const before=await histories(),priorCatalog=await catalog(),migrationRows=(await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    await copyFile(resolve('migrations/020-reviewed-preplay-retry.sql'),join(directory,'020-reviewed-preplay-retry.sql'));await migrate(pool,directory);
    assert.deepEqual(await histories(),before);
    assert.deepEqual((await pool.query('SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',['020-reviewed-preplay-retry.sql'])).rows,migrationRows);
    const after=await catalog();for(const key of Object.keys(priorCatalog) as Array<keyof typeof priorCatalog>){
      const entries=new Set(after[key].map(value=>JSON.stringify(value)));for(const prior of priorCatalog[key])assert.ok(entries.has(JSON.stringify(prior)),key+' changed');
    }
    assert.equal((await pool.query('SELECT 1 FROM playback_preplay_review_permits')).rowCount,0);
    assert.equal((await pool.query('SELECT 1 FROM playback_preplay_releases')).rowCount,0);
    assert.equal((await pool.query('SELECT 1 FROM playback_jobs WHERE reviewed_preplay_release_id IS NOT NULL')).rowCount,0);
    const index=(await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='playback_active_lecture_idx'",[schema])).rows[0].indexdef;
    assert.match(index,/CREATE UNIQUE INDEX/);assert.match(index,/reviewed_preplay_release_id IS NULL/);assert.match(index,/settled_at IS NULL/);
    await store.health();
    const fullAfter=await fullCatalog(),added:Record<string,unknown[]>={},removed:Record<string,unknown[]>={};
    for(const kind of Object.keys(fullBefore)){
      const old=new Set(fullBefore[kind].map((v:unknown)=>JSON.stringify(v))),next=new Set(fullAfter[kind].map((v:unknown)=>JSON.stringify(v)));
      added[kind]=fullAfter[kind].filter((v:unknown)=>!old.has(JSON.stringify(v)));
      removed[kind]=fullBefore[kind].filter((v:unknown)=>!next.has(JSON.stringify(v)));
    }
    assert.deepEqual(Object.entries(removed).filter(([,v])=>v.length).map(([kind])=>kind),['indexes']);
    assert.equal(removed.indexes!.length,1);
    assert.equal((removed.indexes![0] as {name:string}).name,'playback_active_lecture_idx');
    const migration=await readFile(resolve('migrations/020-reviewed-preplay-retry.sql'),'utf8');
    const normalized=JSON.parse(JSON.stringify({before:fullBefore,after:fullAfter,added,removed}).replaceAll(schema,'public'));
    t.diagnostic('ALMS_REVIEWED_PREPLAY_020_CATALOG='+JSON.stringify({version:1,actualPostgres:true,migrationCount:20,newPermitCount:0,newReleaseCount:0,
      newMarkerCount:0,priorFactProjection:'to_jsonb(row)-reviewed_preplay_release_id',historiesBefore:before,historiesAfter:await histories(),
      migrationSha256:createHash('sha256').update(migration).digest('hex'),sourceSnapshotJsSha256:spec.sourceSnapshotJsSha256,
      schemaNameNormalized:true,functionDefinitionSchemaNormalizedBeforeHash:true,...normalized}));
  }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});}
});
