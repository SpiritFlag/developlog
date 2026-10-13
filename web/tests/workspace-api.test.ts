import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createWorkspaceApi } from '../lib/workspace-api';
import type { Database } from '../lib/db';
import { AppError, type Actor } from '../lib/model';
import { commitChanges } from '../lib/service';

const origin = 'http://127.0.0.1:3100';
test('web HTTP contract: project, Topic, Work handoff, Activity memory and History share one database', async () => {
  const sql = new PGlite();
  try {
    await sql.exec(await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8'));
    const db: Database = { query: (q, p) => sql.query(q, p), transaction: fn => sql.transaction(tx => fn({query: (q, p) => tx.query(q, p)})) };
    const projectId = randomUUID();
    const actor: Actor = { id: 'synthetic-http-owner', kind: 'human', projectId };
    const api = createWorkspaceApi(() => db, async () => ({...actor}));
    async function get(query: Record<string,string>) {
      const response = await api.GET(new Request(`${origin}/api/workspace?${new URLSearchParams({project: projectId,...query})}`));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      return response.json();
    }
    async function post(value: unknown, expected = 200) {
      const response = await api.POST(new Request(`${origin}/api/workspace?project=${projectId}`, {
        method: 'POST', headers: {origin, 'content-type':'application/json'}, body: JSON.stringify(value),
      }));
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    }
    await post({action:'create_project',project_id:projectId,name:'Synthetic HTTP project',purpose:'HTTP contract verification'});
    assert.equal((await get({view:'projects'})).items[0].id, projectId);
    await commitChanges(db, actor, {operation_id:randomUUID(),read_set:[],reason:'Synthetic setup',changes:[
      {type:'save_topic',topic_id:'topic',expected_version:0,title:'Topic',slug:'topic',intro:'Synthetic behavior'},
      {type:'set_design',topic_id:'topic',expected_version:0,rule_id:'rule',title:'Rule',design:{text:'The check passes'}},
      {type:'save_record',id:'work',expected_version:0,record:{kind:'work',title:'Verify rule',state:'ready',topic_ids:['topic'],acceptance:'Check passes',acceptance_criteria:[{id:'check',text:'Check passes',required_method:'automated_test'}],recommendation:{model:'Astra',reasoning:'High',reason:'Verify a shared memory contract'}}},
    ]});
    const current = await get({view:'project'});
    assert.equal(current.topics.items[0].id,'topic');
    assert.ok(Array.isArray(current.pending_activities.items));
    assert.equal((await get({view:'topics'})).items[0].slug,'topic');
    const topic = (await get({view:'topic',id:'topic'})).topic;
    assert.equal((await get({view:'records',kind:'work',states:'ready'})).items[0].id,'work');
    const work = (await get({view:'record',id:'work'})).record;
    const handoff = await get({view:'handoff',id:'work'});
    assert.equal(handoff.recommendation.model,'Astra');
    assert.equal(handoff.recommendation.reasoning,'High');
    assert.equal(handoff.ready,true);
    assert.equal(typeof handoff.text,'string');
    const source = randomUUID(), when = '2026-10-12T16:30:00.000Z';
    const evidence = {source_id:source,method:'automated_test',scope:'Synthetic HTTP behavior',target:'Isolated PGlite',observed_at:when};
    const submission = {action:'submit_activity',operation_id:randomUUID(),result_key:randomUUID(),channel:'handoff',work_id:'work',topic_ids:['topic'],summary:'Rule verified',result:'Synthetic check passed',occurred_at:when,
      sources:[{id:source,title:'Synthetic evidence',body:'passed',origin:'test',observed_at:when}],verification:[{id:'check',...evidence,outcome:'passed'}],
      memory:{read_set:handoff.read_set,changes:[{type:'confirm_actual',topic_id:'topic',expected_version:topic.version,rule_id:'rule',actual:{text:'The check passes',evidence:[evidence]},resolves_report:false}],
        work_result:{expected_version:work.version,conclusion:'verified_complete',checks:[{criterion_id:'check',satisfied:true,evidence_ids:['check'],note:'Observed passing check'}]},reason:'Verified via isolated HTTP contract'},
      history:{significance:'behavior',summary:'Rule now verified',reason:'Behavior confirmed',topic_ids:['topic'],evidence_ids:['check']}};
    const result = await post(submission);
    assert.equal(result.memory_status,'applied');
    assert.deepEqual(await post(submission), result);
    assert.equal((await get({view:'topic',id:'topic'})).topic.rules[0].actual.text,'The check passes');
    assert.equal((await get({view:'record',id:'work'})).record.state,'done');
    const activity = (await get({view:'activity',id:result.activity_id})).activity;
    assert.equal(activity.payload.channel,'handoff');
    assert.equal(activity.payload.verification[0].outcome,'passed');
    assert.equal((await get({view:'activities'})).items[0].id, result.activity_id);
    const history = await get({view:'history',date:'2026-10-13'});
    assert.equal(history.items[0].activity_id,result.activity_id);
    // The existing History UI intentionally reads the records display envelope.
    const legacyHistory = await get({view:'records',kind:'event',from_date:'2026-10-13',to_date:'2026-10-13',states:'published,corrected'});
    assert.equal(legacyHistory.items[0].id,history.items[0].id);
    assert.equal((await get({view:'record',id:history.items[0].id})).record.activity_id,result.activity_id);
    await post(null,400);
    await post([],400);
    await post({action:'unsupported'},400);
    const other = createWorkspaceApi(() => db, async () => ({id:'other-owner',kind:'human'}));
    assert.equal((await other.GET(new Request(`${origin}/api/workspace?project=${projectId}`))).status,403);
  } finally { await sql.close(); }
});

test('web HTTP rejects missing auth, cross-origin writes and oversized bodies before database access', async () => {
  let databaseCalls = 0;
  const db = () => { databaseCalls++; throw new Error('Must not access DB'); };
  const anonymous = createWorkspaceApi(db,async () => {throw new AppError(401,'Login required');});
  assert.equal((await anonymous.GET(new Request(`${origin}/api/workspace?view=projects`))).status,401);
  const api = createWorkspaceApi(db, async () => ({id:'synthetic-owner',kind:'human'}));
  for (const suppliedOrigin of ['', 'https://other.invalid']) {
    assert.equal((await api.POST(new Request(`${origin}/api/workspace`,{method:'POST',headers:{origin:suppliedOrigin},body:'{}'}))).status,403);
  }
  assert.equal((await api.POST(new Request(`${origin}/api/workspace`,{method:'POST',headers:{origin},body:'x'.repeat(500001)}))).status,413);
  assert.equal((await api.POST(new Request(`${origin}/api/workspace`,{method:'POST',headers:{origin},body:'{'}))).status,400);
  assert.equal(databaseCalls,0);
});
