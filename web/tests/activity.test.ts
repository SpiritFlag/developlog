import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../lib/db';
import type { Actor } from '../lib/model';
import { commitChanges, createProject } from '../lib/write-service';
import { readProject, readTopic, readHandoff, readRecord, listRecords, searchMemory } from '../lib/service';
import { submitActivity, reconcileActivity, approveCandidate } from '../lib/activity-service';
import { listActivities, listHistory, readActivity } from '../lib/activity-read';
import { submitActivitySchema, type ActivityInput } from '../lib/activity-model';
import { createProjectMcp } from '../lib/mcp-server';

const when = '2026-10-12T16:30:00.000Z'; // Oct 13 in Seoul, Oct 12 in UTC.
const schema = await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8');
async function fixture(timezone='Asia/Seoul') {
  const sql = new PGlite();
  await sql.exec(schema);
  const db: Database = {
    query: (query,params) => sql.query(query,params),
    transaction: fn => sql.transaction(tx => fn({query:(query,params) => tx.query(query,params)})),
  };
  const actor:Actor = {id:'synthetic-owner',kind:'ai',projectId:randomUUID()};
  await createProject(db,actor,{project_id:actor.projectId,name:'Synthetic sandbox',purpose:'Verify memory contracts',timezone});
  await commitChanges(db,actor,{operation_id:randomUUID(),read_set:[],reason:'Synthetic setup',changes:[
    {type:'save_topic',topic_id:'cache',expected_version:0,title:'Cache',slug:'cache',intro:'Synthetic caching behavior'},
    {type:'set_design',topic_id:'cache',expected_version:0,rule_id:'ttl',title:'Expiry',design:{text:'Entries expire after one minute'}},
    {type:'save_topic',topic_id:'other',expected_version:0,title:'Other',slug:'other',intro:'Unchanged topic'},
  ]});
  return {sql,db,actor,close:()=>sql.close()};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function submission(overrides:Record<string,unknown> = {}):ActivityInput {
  const source=randomUUID();
  return submitActivitySchema.parse({
    operation_id:randomUUID(),result_key:randomUUID(),channel:'connected',topic_ids:['cache'],
    summary:'Implemented expiry',result:`Synthetic run ${randomUUID()}: local test passed; no external environment checked.`,occurred_at:when,
    sources:[{id:source,title:'Synthetic test log',body:'expiry spec: passed',origin:'test',observed_at:when}],
    verification:[{id:'test',source_id:source,method:'automated_test',scope:'expiry unit test',target:'synthetic local test',observed_at:when,outcome:'passed'}],
    memory:{read_set:[],changes:[],reason:'No change to current Topic memory'},...overrides,
  });
}
async function confirmed(f:Fixture) {
  const t=(await readTopic(f.db,f.actor,'cache')).topic;
  const s=submission();
  const {id:_id,outcome:_outcome,...evidence}=s.verification[0];
  s.memory={read_set:[{topic_id:t.id,context_version:t.context_version}],changes:[
    {type:'confirm_actual',topic_id:t.id,expected_version:t.version,rule_id:'ttl',actual:{text:'Entries expire after one minute',evidence:[evidence]},resolves_report:false},
    {type:'set_gap',topic_id:t.id,expected_version:t.version,rule_id:'ttl',gap:{state:'aligned',reason:'Expiry unit test agrees with design'}},
  ],work_result:null,reason:'Local expiry behavior verified'};
  return s;
}
async function count(f:Fixture,table:string) {return (await f.db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;}
async function createWork(f:Fixture, state='ready', id='work') {
  const t=(await readTopic(f.db,f.actor,'cache')).topic;
  await commitChanges(f.db,f.actor,{operation_id:randomUUID(),read_set:[{topic_id:t.id,context_version:t.context_version}],reason:'Plan a bounded synthetic task',changes:[
    {type:'save_record',id,expected_version:0,record:{kind:'work',title:'Verify expiry',state,topic_ids:['cache'],acceptance:'Expiry is covered',
      acceptance_criteria:[{id:'expiry',text:'Expiry test passes',required_method:'automated_test'}],recommendation:{model:'Sol',reasoning:'Medium',reason:'One isolated behavior with regression coverage'}}},
  ]});
}

test('fresh schema supports Work-less Activity; no-change does not bump Topic or create History',async()=>{
  const f=await fixture(); try {
    const before=(await readTopic(f.db,f.actor,'cache')).topic;
    const r=await submitActivity(f.db,f.actor,submission());
    assert.equal(r.memory_status,'applied');
    assert.equal(await count(f,'activities'),1); assert.equal(await count(f,'evidence'),1);
    assert.equal(await count(f,'history'),0); assert.equal(await count(f,'works'),0);
    assert.deepEqual((await readTopic(f.db,f.actor,'cache')).topic,before);
  } finally {await f.close();}
});

test('only changed Topic advances; confirmed evidence and gap stay distinct; identical proposal is a no-op',async()=>{
  const f=await fixture(); try {
    const other=(await readTopic(f.db,f.actor,'other')).topic;
    const s=await confirmed(f);
    await submitActivity(f.db,f.actor,s);
    const topic=(await readTopic(f.db,f.actor,'cache')).topic;
    assert.equal(topic.version,2); assert.equal(topic.rules[0].actual?.evidence[0].method,'automated_test');
    assert.equal(topic.rules[0].design?.version,1); assert.equal(topic.rules[0].gap.state,'aligned');
    assert.deepEqual((await readTopic(f.db,f.actor,'other')).topic,other);
    s.operation_id=randomUUID(); s.result_key=randomUUID(); s.result='A different execution reconfirmed the same facts';
    s.memory.read_set=[{topic_id:'cache',context_version:topic.context_version}];
    s.memory.changes.forEach(c=>{c.expected_version=topic.version;});
    await submitActivity(f.db,f.actor,s);
    assert.deepEqual((await readTopic(f.db,f.actor,'cache')).topic,topic);
  } finally {await f.close();}
});

test('unverified Handoff report preserves last confirmed implementation and design gap',async()=>{
  const f=await fixture(); try {
    await submitActivity(f.db,f.actor,await confirmed(f));
    const before=(await readTopic(f.db,f.actor,'cache')).topic;
    const source=randomUUID();
    const s=submission({channel:'handoff',sources:[{id:source,title:'Unverified report',body:'Expiry changed to two minutes',origin:'report'}],verification:[],
      memory:{read_set:[{topic_id:'cache',context_version:before.context_version}],changes:[{type:'report_actual',topic_id:'cache',expected_version:before.version,rule_id:'ttl',text:'Expiry is reportedly two minutes',source_ids:[source],target:'unobserved build'}],reason:'Preserve unverified result'}});
    await submitActivity(f.db,f.actor,s);
    const after=(await readTopic(f.db,f.actor,'cache')).topic;
    assert.deepEqual(after.rules[0].actual,before.rules[0].actual);
    assert.equal(after.rules[0].reported?.text,'Expiry is reportedly two minutes');
    assert.deepEqual(after.rules[0].gap,before.rules[0].gap);
    const bad=await confirmed(f); bad.sources[0].origin='report';
    await assert.rejects(submitActivity(f.db,f.actor,bad),/의도나 구현 보고/);
    assert.equal(await count(f,'activities'),2);
  } finally {await f.close();}
});

test('exact operation retries and same result with another request/key never duplicate records',async()=>{
  const f=await fixture(); try {
    const s=await confirmed(f);
    s.history={significance:'behavior',summary:'Expiry behavior established',reason:'A meaningful behavior changed',topic_ids:['cache'],evidence_ids:['test']};
    const first=await submitActivity(f.db,f.actor,s);
    assert.deepEqual(await submitActivity(f.db,f.actor,s),first);
    const retry=await submitActivity(f.db,f.actor,{...s,operation_id:randomUUID()});
    assert.equal(retry.activity_id,first.activity_id); assert.equal(retry.duplicate,true);
    const another=await submitActivity(f.db,f.actor,{...s,operation_id:randomUUID(),result_key:randomUUID()});
    assert.equal(another.activity_id,first.activity_id);
    await assert.rejects(submitActivity(f.db,f.actor,{...s,result:'different result'}),/요청 ID/);
    await assert.rejects(submitActivity(f.db,f.actor,{...s,operation_id:randomUUID(),result:'different result'}),/결과 키/);
    assert.equal(await count(f,'activities'),1); assert.equal(await count(f,'history'),1);
  } finally {await f.close();}
});

test('stale context saves execution pending, exposes it to the next AI and reconciles without replaying execution',async()=>{
  const f=await fixture(); try {
    const stale=await confirmed(f);
    await createWork(f);
    const r=await submitActivity(f.db,f.actor,stale);
    assert.equal(r.memory_status,'pending');
    assert.equal((await readTopic(f.db,f.actor,'cache')).topic.rules[0].actual,null);
    assert.equal((await readProject(f.db,f.actor)).pending_activities.items[0].id,r.activity_id);
    assert.equal((await readTopic(f.db,f.actor,'cache')).pending_activities.items[0].id,r.activity_id);
    const handoff=await readHandoff(f.db,f.actor,'work');
    assert.ok(handoff.text.includes(r.activity_id)); assert.equal(handoff.recommendation?.model,'Sol');
    const current=(await readTopic(f.db,f.actor,'cache')).topic;
    stale.memory.read_set=[{topic_id:'cache',context_version:current.context_version}];
    const result=await reconcileActivity(f.db,f.actor,{operation_id:randomUUID(),activity_id:r.activity_id,expected_memory_version:1,memory:stale.memory});
    assert.equal(result.status,'applied'); assert.equal(result.memory_version,2);
    assert.equal((await listActivities(f.db,f.actor,{status:'pending'})).items.length,0);
    assert.equal((await readActivity(f.db,f.actor,r.activity_id)).attempts.length,2);
    assert.equal(await count(f,'activities'),1);
    await assert.rejects(reconcileActivity(f.db,f.actor,{operation_id:randomUUID(),activity_id:r.activity_id,expected_memory_version:1,memory:stale.memory}),/버전/);
  } finally {await f.close();}
});

test('Work report is not completion; verified completion matches every saved criterion and method',async()=>{
  const f=await fixture(); try {
    await createWork(f);
    const report=submission({work_id:'work',memory:{read_set:[],changes:[],reason:'Report only',work_result:{expected_version:1,conclusion:'reported_complete',checks:[]}}});
    await submitActivity(f.db,f.actor,report);
    assert.equal((await readRecord(f.db,f.actor,'work')).record.state,'ready');
    const s=submission({work_id:'work'});
    s.memory.read_set=[{topic_id:'cache',context_version:(await readTopic(f.db,f.actor,'cache')).topic.context_version}];
    s.memory.work_result={expected_version:1,conclusion:'verified_complete',checks:[{criterion_id:'expiry',satisfied:true,evidence_ids:['test'],note:'Test passed locally'}]};
    s.verification[0].outcome='failed';
    await assert.rejects(submitActivity(f.db,f.actor,s),/검증이 부족/);
    assert.equal(await count(f,'activities'),1);
    s.verification[0].outcome='passed';
    await submitActivity(f.db,f.actor,s);
    const after=(await readRecord(f.db,f.actor,'work')).record;
    assert.equal(after.state,'done'); assert.equal(after.version,2);
    assert.equal(after.recommendation?.reasoning,'Medium');
  } finally {await f.close();}
});

test('stale Work rolls back every Topic memory change but retains execution and evidence',async()=>{
  const f=await fixture(); try {
    await createWork(f);
    const s=await confirmed(f); s.work_id='work';
    s.memory.work_result={expected_version:99,conclusion:'reported_complete',checks:[]};
    const before=(await readTopic(f.db,f.actor,'cache')).topic;
    const r=await submitActivity(f.db,f.actor,s);
    assert.equal(r.memory_status,'pending');
    assert.deepEqual((await readTopic(f.db,f.actor,'cache')).topic,before);
    assert.equal(await count(f,'activities'),1); assert.equal(await count(f,'evidence'),1);
  } finally {await f.close();}
});

test('follow-up problems deduplicate into a non-executable candidate, including existing planned Work',async()=>{
  const f=await fixture(); try {
    const s=submission(); s.verification[0].outcome='failed';
    s.follow_ups=[{issue_key:'expiry:overflow',existing_work_id:null,title:'Fix overflow',problem:'Overflow reproduced in test',scope:'Fix this boundary only',evidence_ids:['test'],topic_ids:['cache'],acceptance_criteria:[{id:'boundary',text:'Boundary test passes',required_method:'automated_test'}],recommendation:{model:'Sol',reasoning:'High',reason:'Boundary regression risk'}}];
    const r=await submitActivity(f.db,f.actor,s);
    const id='follow_up_work_ids' in r ? r.follow_up_work_ids![0] : '';
    assert.equal((await readRecord(f.db,f.actor,id)).record.state,'candidate');
    assert.equal((await readHandoff(f.db,f.actor,id)).ready,false);
    assert.equal((await readProject(f.db,f.actor)).candidate_work.items.length,1);
    await assert.rejects(approveCandidate(f.db,f.actor,{operation_id:randomUUID(),work_id:id,expected_version:1}),/사용자가/);
    s.operation_id=randomUUID(); s.result_key=randomUUID(); s.result='A second reproduction of the same problem';
    await submitActivity(f.db,f.actor,s);
    assert.equal(await count(f,'works'),1);
    await approveCandidate(f.db,{...f.actor,kind:'human'},{operation_id:randomUUID(),work_id:id,expected_version:1});
    assert.equal((await readHandoff(f.db,f.actor,id)).ready,true);
    assert.equal((await readRecord(f.db,f.actor,id)).record.recommendation?.reasoning,'High');
    const speculative=submission(); speculative.follow_ups=s.follow_ups;
    await assert.rejects(submitActivity(f.db,f.actor,speculative),/推測|추측/);
  } finally {await f.close();}
});

test('History is opt-in, linked, pageable and grouped by project date rather than UTC',async()=>{
  const f=await fixture(); try {
    const s=await confirmed(f);
    s.history={significance:'behavior',summary:'Expiry now works',reason:'Confirmed a meaningful behavior',topic_ids:['cache'],evidence_ids:['test']};
    const r=await submitActivity(f.db,f.actor,s);
    const history=await listHistory(f.db,f.actor,{date:'2026-10-13'});
    assert.equal(history.items.length,1); assert.equal(history.timezone,'Asia/Seoul');
    assert.equal((history.items[0] as unknown as {activity_id:string}).activity_id,r.activity_id);
    assert.equal((await listHistory(f.db,f.actor,{date:'2026-10-12'})).items.length,0);
    assert.equal((await listRecords(f.db,f.actor,{kind:'event'})).items.length,1);
    assert.ok((await searchMemory(f.db,f.actor,{query:'Expiry'})).items.length);
  } finally {await f.close();}
});

test('correction preserves original execution, Topic revisions and the correction reason',async()=>{
  const f=await fixture(); try {
    const original=await submitActivity(f.db,f.actor,await confirmed(f));
    const correction=await confirmed(f);
    correction.result='A later observation corrects the previously recorded expiry';
    correction.correction={activity_id:original.activity_id,reason:'Original observation covered the wrong boundary'};
    const change=correction.memory.changes[0];
    if(change.type==='confirm_actual')change.actual.text='Entries actually expire after two minutes';
    correction.memory.changes[1]={type:'set_gap',topic_id:'cache',expected_version:2,rule_id:'ttl',gap:{state:'planned',reason:'Restore intended one-minute expiry'}};
    const r=await submitActivity(f.db,f.actor,correction);
    assert.equal(r.memory_status,'applied');
    const t=(await readTopic(f.db,f.actor,'cache')).topic;
    assert.equal(t.rules[0].design?.text,'Entries expire after one minute');
    assert.equal(t.rules[0].actual?.text,'Entries actually expire after two minutes');
    assert.equal(t.rules[0].gap.state,'planned');
    assert.equal((await readActivity(f.db,f.actor,original.activity_id)).corrections.length,1);
    assert.equal(await count(f,'activities'),2);
    assert.equal((await f.db.query('SELECT * FROM knowledge_revisions WHERE entity_type=\'topic\' AND entity_id=\'cache\'')).rows.length,3);
  } finally {await f.close();}
});

test('ownership and cross-project references fail closed; malformed evidence leaves no partial write',async()=>{
  const f=await fixture(); try {
    const stranger={...f.actor,id:'synthetic-stranger'};
    await assert.rejects(submitActivity(f.db,stranger,submission()),/접근/);
    await assert.rejects(listHistory(f.db,stranger),/접근/);
    await assert.rejects(submitActivity(f.db,f.actor,submission({topic_ids:['missing']})),/이 프로젝트/);
    const bad=submission();bad.verification[0].source_id=randomUUID();
    await assert.rejects(submitActivity(f.db,f.actor,bad),/이 프로젝트/);
    assert.equal(await count(f,'activities'),0); assert.equal(await count(f,'sources'),0);
  } finally {await f.close();}
});

test('concurrent retries create one Activity; concurrent stale writers preserve the losing execution',async()=>{
  const f=await fixture(); try {
    const s=await confirmed(f);
    const [a,b]=await Promise.all([submitActivity(f.db,f.actor,s),submitActivity(f.db,f.actor,s)]);
    assert.equal(a.activity_id,b.activity_id);
    const next=await confirmed(f);
    const other=structuredClone(next);other.operation_id=randomUUID();other.result_key=randomUUID();other.result='Second concurrent execution';
    if(next.memory.changes[0].type==='confirm_actual')next.memory.changes[0].actual.text='Three minutes';
    if(other.memory.changes[0].type==='confirm_actual')other.memory.changes[0].actual.text='Four minutes';
    const results=await Promise.all([submitActivity(f.db,f.actor,next),submitActivity(f.db,f.actor,other)]);
    assert.deepEqual(results.map(r=>r.memory_status).sort(),['applied','pending']);
    assert.equal(await count(f,'activities'),3);
  } finally {await f.close();}
});

test('regenerated evidence IDs still deduplicate the same execution',async()=>{
  const f=await fixture(); try {
    const first=submission(); const r=await submitActivity(f.db,f.actor,first);
    const second=structuredClone(first);second.operation_id=randomUUID();second.result_key=randomUUID();
    second.sources[0].id=randomUUID();second.verification[0].id='new-test-id';second.verification[0].source_id=second.sources[0].id;
    assert.equal((await submitActivity(f.db,f.actor,second)).activity_id,r.activity_id);
    assert.equal(await count(f,'activities'),1);
  } finally {await f.close();}
});

test('confirmed memory can be retracted; applied corrections supersede obsolete pending reports',async()=>{
  const f=await fixture(); try {
    const first=await submitActivity(f.db,f.actor,await confirmed(f));
    const before=(await readTopic(f.db,f.actor,'cache')).topic;
    const s=submission();s.result='Retract a misleading earlier confirmation';
    s.correction={activity_id:first.activity_id,reason:'Original test did not observe the deployed behavior'};
    s.memory={read_set:[{topic_id:'cache',context_version:before.context_version}],changes:[{type:'retract_actual',topic_id:'cache',expected_version:before.version,rule_id:'ttl',reason:'Confirmation withdrawn; implementation unknown',source_ids:[s.sources[0].id]}],work_result:null,reason:'Correct overstated certainty'};
    await submitActivity(f.db,f.actor,s);
    const t=(await readTopic(f.db,f.actor,'cache')).topic;
    assert.equal(t.rules[0].actual,null);assert.equal(t.rules[0].gap.state,'unknown');assert.ok(t.rules[0].design);
    const stale=await confirmed(f);stale.memory.read_set[0].context_version=1;
    const pending=await submitActivity(f.db,f.actor,stale);assert.equal(pending.memory_status,'pending');
    const replacement=await confirmed(f);replacement.result='Corrected pending report with current context';replacement.correction={activity_id:pending.activity_id,reason:'Replace stale proposal'};
    await submitActivity(f.db,f.actor,replacement);
    const old=await readActivity(f.db,f.actor,pending.activity_id);
    assert.equal(old.activity.memory_status,'superseded');assert.equal(old.attempts.length,2);
    await assert.rejects(reconcileActivity(f.db,f.actor,{operation_id:randomUUID(),activity_id:pending.activity_id,expected_memory_version:2,memory:stale.memory}),/이미 반영/);
  } finally {await f.close();}
});

test('existing Work identity and alias prevent a renamed follow-up from becoming another candidate',async()=>{
  const f=await fixture(); try {
    await createWork(f);
    const s=submission();s.verification[0].outcome='failed';
    s.follow_ups=[{issue_key:'expiry:existing',existing_work_id:'work',title:'Different wording',problem:'Failure observed',scope:'Existing planned scope',topic_ids:['cache'],evidence_ids:['test'],acceptance_criteria:[{id:'test',text:'Test passes',required_method:'automated_test'}],recommendation:{model:'Astra',reasoning:'Extra High',reason:'Structured comparison'}}];
    await submitActivity(f.db,f.actor,s);
    s.operation_id=randomUUID();s.result_key=randomUUID();s.result='Another observed reproduction';s.follow_ups[0].existing_work_id=null;s.follow_ups[0].title='Another title';
    await submitActivity(f.db,f.actor,s);
    assert.equal(await count(f,'works'),1);assert.equal((await readRecord(f.db,f.actor,'work')).record.state,'ready');
  } finally {await f.close();}
});

test('cancelled generated Work cannot bypass user approval through commit_changes',async()=>{
  const f=await fixture(); try {
    const s=submission();s.verification[0].outcome='failed';
    s.follow_ups=[{issue_key:'expiry:approval',existing_work_id:null,title:'Candidate',problem:'Failure observed',scope:'This boundary only',topic_ids:[],evidence_ids:['test'],acceptance_criteria:[{id:'test',text:'Test passes',required_method:'automated_test'}],recommendation:{model:'Sol',reasoning:'Light',reason:'Small isolated repair'}}];
    const result=await submitActivity(f.db,f.actor,s);const id='follow_up_work_ids' in result ? result.follow_up_work_ids![0] : '';
    const update=async(state:string,version:number)=>commitChanges(f.db,f.actor,{operation_id:randomUUID(),read_set:[],reason:'Synthetic transition',changes:[{type:'save_record',id,expected_version:version,record:{kind:'work',title:'Candidate',state}}]});
    await update('cancelled',1);
    await assert.rejects(update('ready',2),/사용자 승인/);
  } finally {await f.close();}
});

test('History pagination and calendar ranges honor DST in the selected project timezone',async()=>{
  const f=await fixture('America/New_York'); try {
    for (const occurred_at of ['2026-11-01T04:30:00.000Z','2026-11-02T04:30:00.000Z','2026-11-02T05:30:00.000Z']) {
      const s=submission({occurred_at,result:`Observed at ${occurred_at}`});
      s.history={significance:'milestone',summary:'A meaningful checkpoint',reason:'Synthetic milestone',topic_ids:['cache'],evidence_ids:['test']};
      await submitActivity(f.db,f.actor,s);
    }
    const first=await listHistory(f.db,f.actor,{date:'2026-11-01',limit:1});
    assert.equal(first.items.length,1);assert.ok(first.next_cursor);
    const second=await listHistory(f.db,f.actor,{date:'2026-11-01',limit:1,cursor:first.next_cursor});
    assert.equal(second.items.length,1);assert.equal(second.next_cursor,null);assert.notEqual(first.items[0].id,second.items[0].id);
    assert.equal((await listRecords(f.db,f.actor,{kind:'event',from_date:'2026-11-01',to_date:'2026-11-01'})).items.length,2);
    await assert.rejects(listHistory(f.db,f.actor,{date:'2026-02-30'}));
  } finally {await f.close();}
});

test('MCP discovers 3.0 contracts and round-trips submit/read using synthetic authenticated request context',{timeout:15000},async()=>{
  const f=await fixture();const oldOwner=process.env.DEVELOPLOG_OWNER_ID;
  process.env.DEVELOPLOG_OWNER_ID=f.actor.id;
  try {
    const handler=createProjectMcp(()=>f.db);
    async function rpc(method:string,params:unknown,userId:string | null=f.actor.id) {
      const req=new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      if(userId) req.auth={token:'synthetic-token',clientId:'local-contract-test',scopes:[],extra:{userId}};
      const response=await handler(req);
      const raw=await response.text();
      const json=raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(5))).find(s=>s.id===1) : JSON.parse(raw);
      assert.equal(response.status,200,raw);
      assert.equal(json.error,undefined,JSON.stringify(json.error));
      return json.result;
    }
    const list=await rpc('tools/list',{});
    for(const name of ['submit_activity','reconcile_activity','list_activities','read_activity','list_history','commit_changes'])assert.ok(list.tools.some((t:{name:string})=>t.name===name));
    const result=await rpc('tools/call',{name:'submit_activity',arguments:{project_id:f.actor.projectId,...submission()}});
    assert.equal(result.isError,undefined,JSON.stringify(result));
    const activity=JSON.parse(result.content[0].text);
    const read=await rpc('tools/call',{name:'read_activity',arguments:{project_id:f.actor.projectId,id:activity.activity_id}});
    assert.equal(JSON.parse(read.content[0].text).activity.memory_status,'applied');
    const denied=await rpc('tools/call',{name:'submit_activity',arguments:{project_id:f.actor.projectId,...submission()}},null);
    assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).status,401);
    assert.equal(await count(f,'activities'),1);
  } finally {if(oldOwner===undefined)delete process.env.DEVELOPLOG_OWNER_ID;else process.env.DEVELOPLOG_OWNER_ID=oldOwner;await f.close();}
});

test('database protects immutable execution, sources, evidence and audit snapshots',async()=>{
  const f=await fixture();try {
    const r=await submitActivity(f.db,f.actor,await confirmed(f));
    for (const query of [
      "UPDATE activities SET result='rewritten'", 'DELETE FROM activities',
      "UPDATE sources SET body='rewritten'", 'DELETE FROM evidence',
      "UPDATE knowledge_revisions SET reason='rewritten'", 'DELETE FROM activity_memory_revisions', 'DELETE FROM operations',
    ]) await assert.rejects(f.db.query(query),/immutable/);
    assert.equal((await readActivity(f.db,f.actor,r.activity_id)).activity.memory_status,'applied');
  } finally {await f.close();}
});

test('a correction marks its original History corrected and preserves both revision snapshots',async()=>{
  const f=await fixture();try {
    const first=await confirmed(f);first.history={significance:'behavior',summary:'First observation',reason:'Initial behavior observation',topic_ids:['cache'],evidence_ids:['test']};
    const r=await submitActivity(f.db,f.actor,first);
    const correction=await confirmed(f);correction.correction={activity_id:r.activity_id,reason:'The original scope was overstated'};
    correction.history={significance:'correction',summary:'Scope corrected',reason:'Correct the original observation scope',topic_ids:['cache'],evidence_ids:['test']};
    await submitActivity(f.db,f.actor,correction);
    const id='history_id' in r ? r.history_id! : '';
    assert.equal((await readRecord(f.db,f.actor,id)).record.state,'corrected');
    assert.equal((await f.db.query('SELECT id FROM knowledge_revisions WHERE entity_id=$1',[id])).rows.length,2);
    assert.equal((await listHistory(f.db,f.actor)).items.length,2);
  } finally {await f.close();}
});

test('older evidence cannot overwrite a later confirmation; pending pagination exposes all results',async()=>{
  const f=await fixture();try {
    await submitActivity(f.db,f.actor,await confirmed(f));
    for(let i=0;i<2;i++) {
      const s=await confirmed(f);s.sources[0].observed_at='2026-10-01T00:00:00.000Z';s.verification[0].observed_at=s.sources[0].observed_at;
      if(s.memory.changes[0].type==='confirm_actual') {
        s.memory.changes[0].actual.text='An older observation';
        s.memory.changes[0].actual.evidence[0].observed_at=s.sources[0].observed_at;
      }
      assert.equal((await submitActivity(f.db,f.actor,s)).memory_status,'pending');
    }
    const a=await listActivities(f.db,f.actor,{status:'pending',limit:1});
    assert.ok(a.next_cursor);
    const b=await listActivities(f.db,f.actor,{status:'pending',limit:1,cursor:a.next_cursor});
    assert.equal(b.next_cursor,null);assert.notEqual(a.items[0].id,b.items[0].id);
    assert.equal((await readTopic(f.db,f.actor,'cache')).topic.rules[0].actual?.text,'Entries expire after one minute');
  } finally {await f.close();}
});

test('completion cannot omit Work Topic context; its pending result remains visible from that Topic',async()=>{
  const f=await fixture();try {
    await createWork(f);
    const s=submission({work_id:'work',topic_ids:[]});
    s.memory.work_result={expected_version:1,conclusion:'verified_complete',checks:[{criterion_id:'expiry',satisfied:true,evidence_ids:['test'],note:'Passed locally'}]};
    const r=await submitActivity(f.db,f.actor,s);
    assert.equal(r.memory_status,'pending');
    assert.equal((await readTopic(f.db,f.actor,'cache')).pending_activities.items[0].id,r.activity_id);
    assert.equal((await readRecord(f.db,f.actor,'work')).record.state,'ready');
  }finally {await f.close();}
});
