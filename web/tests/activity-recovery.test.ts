import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { RecoveryJournal } from '../scripts/activity-recovery';
import { createProject, commitChanges } from '../lib/write-service';
import { submitActivity, reconcileActivity } from '../lib/activity-service';
import { readTopic, readRecord } from '../lib/service';
import { readActivity } from '../lib/activity-read';
import { submitActivitySchema, reconcileActivitySchema } from '../lib/activity-model';
import type { Database } from '../lib/db';
import type { Actor } from '../lib/model';

const exec = promisify(execFile);
const when = '2026-10-13T06:00:00.000Z';
const marker = 'SYNTHETIC_PRIVATE_RESULT_DO_NOT_LOG';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'developlog-recovery-'));
  const directory = join(root, '.local', 'developlog-activity');
  const sql = new PGlite();
  await sql.exec(await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8'));
  const db: Database = { query: (q,p) => sql.query(q,p),
    transaction: fn => sql.transaction(tx => fn({ query: (q,p) => tx.query(q,p) })) };
  const actor: Actor & { projectId: string } = { id: 'synthetic-recovery-owner', kind: 'ai', projectId: randomUUID() };
  await createProject(db, actor, { project_id: actor.projectId, name: 'Synthetic recovery' });
  await commitChanges(db, actor, { operation_id: randomUUID(), read_set: [], reason: 'Synthetic setup', changes: [
    { type:'save_topic', topic_id:'recovery', expected_version:0, title:'Recovery', slug:'recovery', intro:'Synthetic only' },
    { type:'set_design', topic_id:'recovery', expected_version:0, rule_id:'contract', title:'Delivery', design:{text:'Preserve one result'} },
  ] });
  const journal = () => new RecoveryJournal(directory, actor.projectId);
  const count = async (table: 'activities' | 'history' | 'memory_attempts') =>
    (await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const close = async () => {
    await sql.close();
    assert.equal(dirname(root), tmpdir()); assert(basename(root).startsWith('developlog-recovery-'));
    await rm(root, {recursive:true,force:true});
  };
  return {root,directory,sql,db,actor,journal,count,close};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(f: Fixture) {
  const op = randomUUID();
  return { project_id:f.actor.projectId!, ...submitActivitySchema.parse({operation_id:op,result_key:`codex:${op}`,channel:'connected',
    summary:'Synthetic isolated result',result:marker,occurred_at:when,topic_ids:[],
    memory:{read_set:[],changes:[],reason:'Synthetic result only'} }) };
}
async function changing(f: Fixture) {
  const topic = (await readTopic(f.db,f.actor,'recovery')).topic;
  await commitChanges(f.db,f.actor,{operation_id:randomUUID(),read_set:[{topic_id:topic.id,context_version:topic.context_version}],reason:'Synthetic Work',changes:[
    {type:'save_record',id:'work',expected_version:0,record:{kind:'work',title:'Synthetic verified delivery',state:'ready',topic_ids:['recovery'],
      acceptance_criteria:[{id:'delivery',text:'Synthetic delivery observed',required_method:'automated_test'}]}}]});
  const current=(await readTopic(f.db,f.actor,'recovery')).topic;
  const source=randomUUID(),r=request(f);
  return {...r,work_id:'work',topic_ids:['recovery'],sources:[{id:source,title:'Synthetic evidence',body:'Synthetic test passed',origin:'test',observed_at:when}],
    verification:[{id:'test',source_id:source,method:'automated_test',scope:'Isolated synthetic fixture',target:'Synthetic service',observed_at:when,outcome:'passed'}],
    memory:{read_set:[{topic_id:current.id,context_version:current.context_version}],reason:'Synthetic confirmed behavior',changes:[
      {type:'confirm_actual',topic_id:current.id,expected_version:current.version,rule_id:'contract',actual:{text:'One result preserved',evidence:[
        {source_id:source,method:'automated_test',scope:'Isolated synthetic fixture',target:'Synthetic service',observed_at:when}]}},
      {type:'set_gap',topic_id:current.id,expected_version:current.version,rule_id:'contract',gap:{state:'aligned',reason:'Synthetic confirmed'}}],
      work_result:{expected_version:1,conclusion:'verified_complete',checks:[{criterion_id:'delivery',satisfied:true,evidence_ids:['test'],note:'Synthetic passed'}]}},
    history:{significance:'behavior',summary:'Synthetic delivery',reason:'Synthetic meaningful result',topic_ids:['recovery'],evidence_ids:['test']} };
}
async function submit(f: Fixture, raw: Record<string,unknown>) {
  const {project_id,...args}=raw; assert.equal(project_id,f.actor.projectId);
  return submitActivity(f.db,f.actor,submitActivitySchema.parse(args));
}
function reconcileArgs(raw: Record<string,unknown>) { const {project_id:_project,...args}=raw; return reconcileActivitySchema.parse(args); }

test('offline before send preserves exact result across a fresh process and later submits once', {timeout:30000}, async () => {
  const f=await fixture(); try {
    const r=request(f), j=f.journal(); await j.prepare(r);
    const bytes=await readFile(join(f.directory,`${r.operation_id}.request.json`),'utf8');
    await j.beginAttempt(r.operation_id); await j.noteFailure(r.operation_id,'before_send');
    assert.equal(await f.count('activities'),0);
    const moduleUrl=new URL('../scripts/activity-recovery.ts',import.meta.url).href;
    const script=`import {RecoveryJournal} from ${JSON.stringify(moduleUrl)}; const j=new RecoveryJournal(${JSON.stringify(f.directory)},${JSON.stringify(f.actor.projectId)}); console.log(JSON.stringify(await j.inspect(${JSON.stringify(r.operation_id)})));`;
    const child=await exec(process.execPath,['--import','tsx','--input-type=module','-e',script],{timeout:10000});
    assert(!child.stdout.includes(marker)); assert(!child.stderr.includes(marker));
    const status=JSON.parse(child.stdout); assert.equal(status.status,'not_sent'); assert.equal(status.action,'submit_activity');
    const restarted=f.journal(), exact=await restarted.beginAttempt(r.operation_id); assert.deepEqual(exact,r);
    await restarted.recordReceipt(r.operation_id,await submit(f,exact));
    assert.equal((await f.journal().inspect(r.operation_id)).action,'none');
    assert.equal(await f.count('activities'),1); assert.equal(await f.count('history'),0);
    assert.equal(await readFile(join(f.directory,`${r.operation_id}.request.json`),'utf8'),bytes);
  } finally {await f.close();}
});

test('lost response retries original operation and creates Activity History and Work effects once', {timeout:30000}, async () => {
  const f=await fixture(); try {
    const r=await changing(f),j=f.journal(); await j.prepare(r);
    const exact=await j.beginAttempt(r.operation_id); const first=await submit(f,exact); // commit, then lose transport response
    await j.noteFailure(r.operation_id,'unknown');
    const before=(await readTopic(f.db,f.actor,'recovery')).topic;
    const restarted=f.journal(); const second=await submit(f,await restarted.beginAttempt(r.operation_id));
    assert.deepEqual(second,first); await restarted.recordReceipt(r.operation_id,second);
    assert.equal(await f.count('activities'),1); assert.equal(await f.count('history'),1);
    assert.deepEqual((await readTopic(f.db,f.actor,'recovery')).topic,before);
    assert.equal((await readRecord(f.db,f.actor,'work')).record.state,'done');
    assert.equal((await readActivity(f.db,f.actor,first.activity_id)).attempts.length,1);
    await assert.rejects(restarted.beginAttempt(r.operation_id));
    await restarted.prepare(r); assert.equal((await restarted.inspect(r.operation_id)).action,'none');
  } finally {await f.close();}
});

test('pending reads current Topic and Work and reconciles once without resubmitting the execution', {timeout:30000}, async () => {
  const f=await fixture(); try {
    const r=await changing(f),j=f.journal(); await j.prepare(r);
    const current=(await readTopic(f.db,f.actor,'recovery')).topic;
    await commitChanges(f.db,f.actor,{operation_id:randomUUID(),read_set:[{topic_id:current.id,context_version:current.context_version}],reason:'Synthetic concurrent change',changes:[
      {type:'set_design',topic_id:current.id,expected_version:current.version,rule_id:'contract',title:'Delivery',design:{text:'Preserve one result with current context'}}]});
    const saved=await submit(f,await j.beginAttempt(r.operation_id)); assert.equal(saved.memory_status,'pending');
    await j.recordReceipt(r.operation_id,saved); assert.equal((await j.inspect(r.operation_id)).action,'read_activity');
    await assert.rejects(j.beginAttempt(r.operation_id));
    const activity=(await readActivity(f.db,f.actor,saved.activity_id)).activity;
    const topic=(await readTopic(f.db,f.actor,'recovery')).topic,work=(await readRecord(f.db,f.actor,'work')).record;
    const memory=structuredClone(r.memory); memory.read_set=[{topic_id:topic.id,context_version:topic.context_version}];
    memory.changes.forEach(c=>{c.expected_version=topic.version;}); memory.work_result.expected_version=work.version;
    const reconcile={project_id:f.actor.projectId!,operation_id:randomUUID(),activity_id:activity.id,expected_memory_version:activity.memory_version,memory};
    await j.prepareReconcile(r.operation_id,reconcile);
    const sent=await j.beginAttempt(reconcile.operation_id);
    const result=await reconcileActivity(f.db,f.actor,reconcileArgs(sent));
    await j.recordReceipt(reconcile.operation_id,result);
    assert.equal((await f.journal().inspect(r.operation_id)).action,'none'); // stale original pending receipt must not regress latest state
    assert.equal(await f.count('activities'),1); assert.equal(await f.count('history'),1);
    assert.equal((await readRecord(f.db,f.actor,'work')).record.state,'done');
    assert.equal((await readActivity(f.db,f.actor,activity.id)).attempts.length,2);
    const replay=await reconcileActivity(f.db,f.actor,reconcileArgs(await j.loadRequest(reconcile.operation_id)));
    assert.deepEqual(replay,result); assert.equal((await readActivity(f.db,f.actor,activity.id)).attempts.length,2);
    assert.deepEqual(await j.loadRequest(r.operation_id),r);
  } finally {await f.close();}
});

test('unresolved pending retains execution and gives a bounded private notice instead of a new Activity', {timeout:30000}, async () => {
  const f=await fixture(); try {
    const r=await changing(f),j=f.journal();r.memory.read_set[0].context_version=1;await j.prepare(r);
    const pending=await submit(f,await j.beginAttempt(r.operation_id));await j.recordReceipt(r.operation_id,pending);
    await j.noteFailure(r.operation_id,'auth');
    const status=await f.journal().inspect(r.operation_id);
    assert.equal(status.status,'pending');assert.equal(status.action,'user_action');assert(status.notice);
    assert(!JSON.stringify(status).includes(marker));assert.equal(await f.count('activities'),1);
    assert.deepEqual(await j.loadRequest(r.operation_id),r);assert.equal((await readRecord(f.db,f.actor,'work')).record.state,'ready');
  } finally {await f.close();}
});

test('repeated connection failure stops quietly until needed and resumes the same request after reconnection', {timeout:30000}, async () => {
  const f=await fixture();try {
    const r=request(f),j=f.journal();await j.prepare(r);
    for(let n=0;n<2;n++){await j.beginAttempt(r.operation_id);await j.noteFailure(r.operation_id,'before_send');}
    const stopped=await j.inspect(r.operation_id);assert.equal(stopped.action,'user_action');assert(stopped.notice);
    assert(!JSON.stringify(stopped).includes(marker));await assert.rejects(j.beginAttempt(r.operation_id));
    assert.equal(await f.count('activities'),0);assert.deepEqual(await j.loadRequest(r.operation_id),r);
    await f.journal().resume(r.operation_id);const connected=f.journal();await connected.recordReceipt(r.operation_id,await submit(f,await connected.beginAttempt(r.operation_id)));
    assert.equal(await f.count('activities'),1);assert.equal((await connected.inspect(r.operation_id)).notice,null);
  }finally{await f.close();}
});

test('receipt survives interrupted state update; tampering and wrong-project requests fail without payload leakage', {timeout:30000}, async () => {
  const f=await fixture();try {
    const r=request(f),j=f.journal();await j.prepare(r);const response=await submit(f,await j.beginAttempt(r.operation_id));
    // Crash between writing a durable receipt and updating the state file.
    await writeFile(join(f.directory,`${r.operation_id}.receipt.json`),JSON.stringify(response));
    assert.equal((await f.journal().inspect(r.operation_id)).action,'none');
    await assert.rejects(j.prepare({...r,project_id:randomUUID()}),e=>!String(e).includes(marker));
    await writeFile(join(f.directory,`${r.operation_id}.request.json`),JSON.stringify({...r,result:'Changed bytes'}));
    await assert.rejects(j.beginAttempt(r.operation_id),e=>!String(e).includes(marker));
    assert.equal(await f.count('activities'),1);
  }finally{await f.close();}
});

test('local payloads are Git and deployment excluded; status inspections create no Activity or public body', {timeout:30000}, async () => {
  const f=await fixture();try {
    const r=request(f),j=f.journal();await j.prepare(r);
    await exec('git',['init','--quiet',f.root],{timeout:10000});
    await writeFile(join(f.root,'.gitignore'),await readFile(new URL('../../.gitignore',import.meta.url),'utf8'));
    const ignored=await exec('git',['check-ignore','--no-index','.local/developlog-activity/'+r.operation_id+'.request.json'],{cwd:f.root,timeout:10000});
    assert(ignored.stdout.includes('.local/developlog-activity/'));
    assert((await readFile(new URL('../../.vercelignore',import.meta.url),'utf8')).includes('**/.local/**'));
    assert(!JSON.stringify(await j.inspect(r.operation_id)).includes(marker));assert.equal(await f.count('activities'),0);
    assert((await readdir(f.directory)).every(name=>!name.endsWith('.log')));
    assert.throws(()=>new RecoveryJournal(join(f.root,'public','developlog-activity'),f.actor.projectId));
  }finally{await f.close();}
});
