import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Executor } from './db';
import { AppError, recordInputSchema, type Actor, type Evidence, type Memory } from './model';
import { project, projectId, getRecord } from './service';
import { audit, canonical, commitChanges, operation, storeRecord, validateEvidence, validateSources } from './write-service';
import { submitActivitySchema, reconcileActivitySchema, type Activity, type ActivityInput, type MemoryProposal } from './activity-model';

const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const normalize = (v: string) => v.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
const asEvidence = ({ source_id, method, scope, target, observed_at }: Evidence): Evidence =>
  ({ source_id, method, scope, target, observed_at });
const isConfirmed = (e: ActivityInput['verification'][number]) =>
  e.method !== 'documented' && (e.method === 'automated_test' ? e.outcome === 'passed' : e.outcome === 'observed');

async function validateTopics(tx: Executor, pid: string, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = (await tx.query('SELECT id FROM topics WHERE project_id=$1 AND id=ANY($2::text[])', [pid, unique])).rows;
  if (rows.length !== unique.length) throw new AppError(400, '연결한 Topic이 이 프로젝트에 없어요. 먼저 Topic을 만들어 주세요.');
}

async function saveSources(tx: Executor, actor: Actor, input: ActivityInput) {
  for (const s of input.sources) {
    const before = (await tx.query<{title: string; body: string; origin: string; url: string | null; ref: string | null; observed_at: string | Date}>(
      'SELECT title,body,origin,url,ref,observed_at FROM sources WHERE project_id=$1 AND id=$2', [projectId(actor), s.id],
    )).rows[0];
    if (before) {
      if (before.title !== s.title || before.body !== s.body || before.origin !== s.origin || before.url !== s.url || before.ref !== s.ref ||
        (s.observed_at && new Date(before.observed_at).toISOString() !== s.observed_at))
        throw new AppError(409, '기존 근거 원문은 덮어쓸 수 없어요. 새 source ID를 사용해 주세요.');
      continue;
    }
    await tx.query(`INSERT INTO sources(project_id,id,kind,title,body,url,ref,origin,captured_by,observed_at,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$3,COALESCE($9::timestamptz,now()),$10)`,
      [projectId(actor), s.id, actor.kind, s.title, s.body, s.url, s.ref, s.origin, s.observed_at, JSON.stringify({actor: actor.id})]);
  }
}

function referencedEvidence(input: ActivityInput, ids: string[]) {
  return ids.map(id => {
    const e = input.verification.find(e => e.id === id);
    if (!e) throw new AppError(400, '제출에 없는 검증 근거 ID예요.', { evidence_id: id });
    return e;
  });
}

async function validateProposal(tx: Executor, pid: string, input: ActivityInput, memory: MemoryProposal) {
  if (memory.work_result && !input.work_id) throw new AppError(400, 'work_result에는 work_id가 필요해요.');
  if (new Set(memory.read_set.map(r => r.topic_id)).size !== memory.read_set.length)
    throw new AppError(400, 'read_set에 중복 Topic이 있어요.');
  for (const c of memory.changes) {
    if (!input.topic_ids.includes(c.topic_id)) throw new AppError(400, '변경할 Topic을 topic_ids에 포함해 주세요.');
    if (c.type === 'save_topic') await validateSources(tx, pid, c.source_ids ?? []);
    if (c.type === 'set_design') await validateSources(tx, pid, c.design.source_ids);
    if (c.type === 'report_actual') await validateSources(tx, pid, c.source_ids);
    if (c.type === 'retract_actual' || c.type === 'clear_report') {
      if (!input.correction) throw new AppError(400,'기억 철회에는 원래 Activity와 정정 이유가 필요해요.');
      await validateSources(tx,pid,c.source_ids);
    }
    if (c.type === 'confirm_actual') {
      await validateEvidence(tx, pid, c.actual.evidence);
      for (const e of c.actual.evidence) {
        if (!input.verification.some(v => isConfirmed(v) && canonical(asEvidence(v)) === canonical(e)))
          throw new AppError(400, '확인된 구현에는 이 Activity의 코드·통과 시험·관찰 근거가 필요해요.');
      }
    }
  }
  for (const check of memory.work_result?.checks ?? []) referencedEvidence(input, check.evidence_ids);
}

async function applyWorkResult(tx: Executor, actor: Actor, activity: Activity, memory: MemoryProposal, operationId: string) {
  if (!memory.work_result) return null;
  const work = await getRecord(tx, activity.project_id, activity.work_id!);
  const result = memory.work_result;
  if (work.version !== result.expected_version) throw new AppError(409, 'Work 버전이 바뀌었어요.', { work_id: work.id, version: work.version });
  if (new Set(result.checks.map(c => c.criterion_id)).size !== result.checks.length)
    throw new AppError(400, '완료 조건 검증이 중복됐어요.');
  if (result.checks.some(c => !work.acceptance_criteria.some(a => a.id === c.criterion_id)))
    throw new AppError(400, 'Work에 없는 완료 조건이에요.');
  if (result.conclusion !== 'verified_complete') return { work_id: work.id, state: work.state, conclusion: result.conclusion };
  if (['candidate','cancelled'].includes(work.state)) throw new AppError(400, '승인되지 않았거나 취소된 Work는 완료할 수 없어요.');
  if (!work.acceptance_criteria.length) throw new AppError(400, '완료 전에 구조화된 완료 조건을 저장해 주세요.');
  for (const criterion of work.acceptance_criteria) {
    const check = result.checks.find(c => c.criterion_id === criterion.id);
    const evidence = referencedEvidence(activity.payload, check?.evidence_ids ?? []);
    if (!check?.satisfied || !evidence.every(isConfirmed) || !evidence.some(e => e.method === criterion.required_method && isConfirmed(e)))
      throw new AppError(400, '완료 조건에 맞는 검증이 부족해요.', { criterion_id: criterion.id });
  }
  for (const id of work.depends_on) {
    if ((await getRecord(tx, activity.project_id, id)).state !== 'done') throw new AppError(409, '선행 Work가 아직 끝나지 않았어요.');
  }
  if (work.state === 'done') return { work_id: work.id, state: 'done', conclusion: result.conclusion };
  const evidence = referencedEvidence(activity.payload, [...new Set(result.checks.flatMap(c => c.evidence_ids))]).map(asEvidence);
  const after = await storeRecord(tx, activity.project_id, work.id, work.version + 1, recordInputSchema.parse({
    ...Object.fromEntries(Object.keys(recordInputSchema.shape).map(k => [k, work[k as keyof Memory]])),
    state: 'done', evidence,
  }));
  await audit(tx, actor, 'record', after, operationId, memory.reason);
  // Work context changes invalidate handoffs without changing Topic content versions.
  await tx.query('UPDATE topics SET context_version=context_version+1 WHERE project_id=$1 AND id=ANY($2::text[])', [activity.project_id, work.topic_ids]);
  return { work_id: work.id, state: after.state, conclusion: result.conclusion };
}

async function applyMemory(tx: Executor, actor: Actor, activity: Activity, memory: MemoryProposal, operationId: string) {
  await validateProposal(tx, activity.project_id, activity.payload, memory);
  await tx.query('SAVEPOINT activity_memory');
  let result: { status: 'pending' | 'applied'; conflicts: unknown[]; updated?: unknown; work?: unknown };
  try {
    if (memory.work_result?.conclusion === 'verified_complete' && activity.work_id) {
      const work = await getRecord(tx,activity.project_id,activity.work_id);
      for (const topic_id of work.topic_ids) {
        if (!memory.read_set.some(basis => basis.topic_id === topic_id))
          throw new AppError(409,'Work 완료 전에 관련 Topic 맥락을 읽어 주세요.',{topic_id});
      }
    }
    // All memory changes are one savepoint. The immutable execution report lives outside it.
    const adapter: Database = { query: tx.query.bind(tx), transaction: fn => fn(tx) };
    let updated: unknown = [];
    if (memory.changes.length) {
      updated = await commitChanges(adapter, actor, { operation_id: randomUUID(), read_set: memory.read_set,
        changes: memory.changes, reason: memory.reason, sources: [] });
    } else {
      for (const basis of memory.read_set) {
        const t = (await tx.query<{context_version: number}>('SELECT context_version FROM topics WHERE project_id=$1 AND id=$2', [activity.project_id, basis.topic_id])).rows[0];
        if (!t || t.context_version !== basis.context_version) throw new AppError(409, 'Topic 맥락이 바뀌었어요.', basis);
      }
    }
    const work = await applyWorkResult(tx, actor, activity, memory, operationId);
    result = { status: 'applied', conflicts: [], updated, work };
    await tx.query('RELEASE SAVEPOINT activity_memory');
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT activity_memory');
    await tx.query('RELEASE SAVEPOINT activity_memory');
    if (!(error instanceof AppError) || error.status !== 409) throw error;
    result = { status: 'pending', conflicts: [{ message: error.message, details: error.details ?? null }] };
  }
  const version = activity.memory_version + 1;
  await tx.query('UPDATE activities SET memory_status=$3,memory_version=$4,conflicts=$5 WHERE project_id=$1 AND id=$2',
    [activity.project_id, activity.id, result.status, version, JSON.stringify(result.conflicts)]);
  await tx.query(`INSERT INTO activity_memory_revisions(project_id,activity_id,version,operation_id,proposal,result,actor_id,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [activity.project_id, activity.id, version, operationId, JSON.stringify(memory), JSON.stringify(result), actor.id, memory.reason]);
  if (result.status === 'applied' && activity.corrects_activity_id) {
    const original = await getActivity(tx,actor,activity.corrects_activity_id);
    if (original.memory_status === 'pending') {
      await tx.query("UPDATE activities SET memory_status='superseded',memory_version=memory_version+1,conflicts='[]' WHERE project_id=$1 AND id=$2",[activity.project_id,original.id]);
      await tx.query(`INSERT INTO activity_memory_revisions(project_id,activity_id,version,operation_id,proposal,result,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[activity.project_id,original.id,original.memory_version+1,operationId,JSON.stringify(original.payload.memory),JSON.stringify({status:'superseded',correction_activity_id:activity.id}),actor.id,activity.payload.correction!.reason]);
    }
    const previousHistory = (await tx.query<{id:string}>("SELECT id FROM records WHERE project_id=$1 AND activity_id=$2 AND kind='event' AND state='published'",[activity.project_id,original.id])).rows;
    for (const entry of previousHistory) {
      await tx.query("UPDATE records SET state='corrected',version=version+1,updated_at=now() WHERE project_id=$1 AND id=$2",[activity.project_id,entry.id]);
      await audit(tx,actor,'record',await getRecord(tx,activity.project_id,entry.id),operationId,activity.payload.correction!.reason);
    }
  }
  return { ...result, memory_version: version };
}

async function createFollowUps(tx: Executor, actor: Actor, activity: Activity) {
  const ids: string[] = [];
  for (const f of activity.payload.follow_ups) {
    const proof = referencedEvidence(activity.payload, f.evidence_ids);
    if (!proof.some(e => e.method !== 'documented' && ['failed','observed'].includes(e.outcome)))
      throw new AppError(400, '후속 Work에는 실패나 관찰로 확인된 문제가 필요해요. 추측만으로 만들 수 없어요.');
    const works = (await tx.query<{id: string; title: string; issue_key: string | null}>('SELECT id,title,issue_key FROM records WHERE project_id=$1 AND kind=\'work\'', [activity.project_id])).rows;
    const alias = (await tx.query<{work_id:string}>('SELECT work_id FROM work_issue_keys WHERE project_id=$1 AND issue_key=$2',[activity.project_id,f.issue_key])).rows[0];
    const matches = works.filter(w => w.id === f.existing_work_id || w.id === alias?.work_id || w.issue_key === f.issue_key || normalize(w.title) === normalize(f.title));
    if (f.existing_work_id && !works.some(w => w.id === f.existing_work_id)) throw new AppError(400, '기존 Work가 이 프로젝트에 없어요.');
    if (matches.length) {
      ids.push(...matches.map(w => w.id));
      if (matches.length === 1) await tx.query('INSERT INTO work_issue_keys VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[activity.project_id,f.issue_key,matches[0].id]);
      continue;
    }
    const id = randomUUID();
    const after = await storeRecord(tx, activity.project_id, id, 1, recordInputSchema.parse({
      kind: 'work', title: f.title, summary: f.problem.slice(0,500), body: f.scope,
      state: 'candidate', acceptance: f.acceptance_criteria.map(c => c.text).join('\n').slice(0,2000),
      acceptance_criteria: f.acceptance_criteria, recommendation: f.recommendation,
      issue_key: f.issue_key, topic_ids: f.topic_ids, evidence: proof.map(asEvidence), source_ids: [...new Set(proof.map(e => e.source_id))],
    }));
    await tx.query('UPDATE records SET generated_by_activity=$3 WHERE project_id=$1 AND id=$2', [activity.project_id, id, activity.id]);
    await tx.query('INSERT INTO work_issue_keys VALUES($1,$2,$3)',[activity.project_id,f.issue_key,id]);
    await audit(tx, actor, 'record', {...after,generated_by_activity:activity.id}, activity.payload.operation_id, f.problem);
    await tx.query('UPDATE topics SET context_version=context_version+1 WHERE project_id=$1 AND id=ANY($2::text[])', [activity.project_id, f.topic_ids]);
    ids.push(id);
  }
  return [...new Set(ids)];
}

export async function submitActivity(db: Database, actor: Actor, value: unknown) {
  const input = submitActivitySchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(input)) > 500000) throw new AppError(413, 'Activity가 너무 커요.');
  // Proposal/read versions and transport IDs are excluded: one execution has one identity.
  const { operation_id: _operation, result_key: _key, memory: _memory, history: _history, follow_ups: _followUps, channel: _channel, ...execution } = input;
  // Regenerated source/evidence UUIDs do not turn the same submitted execution into a new result.
  const sourceKeys = new Map(input.sources.map(({id,...s}) => [id,digest(s)]));
  const resultHash = digest({...execution,
    topic_ids:[...new Set(input.topic_ids)].sort(),
    sources:input.sources.map(({id:_id,...s})=>s).sort((a,b)=>canonical(a).localeCompare(canonical(b))),
    verification:input.verification.map(({id:_id,...e})=>({...e,source_id:sourceKeys.get(e.source_id) ?? e.source_id})).sort((a,b)=>canonical(a).localeCompare(canonical(b))),
  });
  return operation(db, actor, input.operation_id, { action: 'submit_activity', ...input }, async (tx, p) => {
    const prior = (await tx.query<Activity>('SELECT * FROM activities WHERE project_id=$1 AND (result_key=$2 OR result_hash=$3)', [p.id, input.result_key, resultHash])).rows;
    if (prior.some(a => a.result_key === input.result_key && a.result_hash !== resultHash)) throw new AppError(409, '같은 결과 키의 실행 내용이 달라요.');
    if (prior[0]) return { activity_id: prior[0].id, duplicate: true, memory_status: prior[0].memory_status, memory_version: prior[0].memory_version };
    if (new Set(input.verification.map(e => e.id)).size !== input.verification.length) throw new AppError(400, '검증 ID가 중복됐어요.');
    if (new Set(input.sources.map(s => s.id)).size !== input.sources.length) throw new AppError(400, '원문 ID가 중복됐어요.');
    await validateTopics(tx, p.id, [...input.topic_ids, ...input.follow_ups.flatMap(f => f.topic_ids), ...(input.history?.topic_ids ?? [])]);
    if (input.follow_ups.some(f => f.topic_ids.some(id => !input.topic_ids.includes(id))) || input.history?.topic_ids.some(id => !input.topic_ids.includes(id)))
      throw new AppError(400, '후속 Work와 History는 이 Activity의 Topic 범위에 연결해 주세요.');
    const linkedWork = input.work_id ? await getRecord(tx,p.id,input.work_id) : null;
    if (linkedWork && linkedWork.kind !== 'work') throw new AppError(400, 'Work만 연결할 수 있어요.');
    if (input.correction) await getActivity(tx, actor, input.correction.activity_id);
    await saveSources(tx, actor, input);
    await validateEvidence(tx, p.id, input.verification);
    await validateProposal(tx, p.id, input, input.memory);
    const id = randomUUID();
    const activity = (await tx.query<Activity>(`INSERT INTO activities(project_id,id,result_key,result_hash,actor_id,channel,work_id,summary,result,occurred_at,payload,memory_status,corrects_activity_id,correction_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13) RETURNING *`,
      [p.id,id,input.result_key,resultHash,actor.id,input.channel,input.work_id,input.summary,input.result,input.occurred_at,JSON.stringify(input),input.correction?.activity_id ?? null,input.correction?.reason ?? null])).rows[0];
    for (const tid of new Set([...input.topic_ids,...(linkedWork?.topic_ids ?? [])])) await tx.query('INSERT INTO activity_topics VALUES($1,$2,$3)', [p.id,id,tid]);
    for (const e of input.verification) await tx.query(`INSERT INTO evidence(project_id,id,activity_id,source_id,method,scope,target,observed_at,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [p.id,`${id}/${e.id}`,id,e.source_id,e.method,e.scope,e.target,e.observed_at,e.outcome]);
    const memory = await applyMemory(tx, actor, activity, input.memory, input.operation_id);
    const followUpIds = await createFollowUps(tx, actor, activity);
    let historyId: string | null = null;
    if (input.history) {
      const h = input.history;
      const proof = referencedEvidence(input, h.evidence_ids);
      historyId = randomUUID();
      const record = await storeRecord(tx, p.id, historyId, 1, recordInputSchema.parse({
        kind:'event', title: h.summary.slice(0,160), summary: h.summary, state:'published', reason:h.reason,
        occurred_at:input.occurred_at, topic_ids:h.topic_ids, evidence:proof.map(asEvidence), source_ids:[...new Set(proof.map(e => e.source_id))],
      }));
      await tx.query('UPDATE records SET activity_id=$3,significance=$4 WHERE project_id=$1 AND id=$2', [p.id,historyId,id,h.significance]);
      await audit(tx, actor, 'record', record, input.operation_id, h.reason);
    }
    return { activity_id:id, duplicate:false, memory_status:memory.status, memory_version:memory.memory_version, conflicts:memory.conflicts, history_id:historyId, follow_up_work_ids:followUpIds };
  });
}

export async function getActivity(tx: Executor, actor: Actor, id: string) {
  await project(tx, actor);
  const activity = (await tx.query<Activity>('SELECT * FROM activities WHERE project_id=$1 AND id=$2', [projectId(actor), id])).rows[0];
  if (!activity) throw new AppError(404, 'Activity를 찾을 수 없어요.');
  return activity;
}

export async function reconcileActivity(db: Database, actor: Actor, value: unknown) {
  const input = reconcileActivitySchema.parse(value);
  return operation(db, actor, input.operation_id, {action:'reconcile_activity', ...input}, async tx => {
    const activity = await getActivity(tx, actor, input.activity_id);
    if (activity.memory_version !== input.expected_memory_version) throw new AppError(409, '기억 반영 버전이 바뀌었어요.');
    if (activity.memory_status !== 'pending') throw new AppError(409, '이미 반영됐어요. 정정은 새 Activity로 남겨 주세요.');
    return {activity_id:activity.id, ...await applyMemory(tx, actor, activity, input.memory, input.operation_id)};
  });
}

export const approveCandidateSchema = z.object({operation_id:z.string().uuid(), work_id:z.string().min(1).max(120), expected_version:z.number().int().positive()}).strict();
export async function approveCandidate(db: Database, actor: Actor, value: unknown) {
  const input = approveCandidateSchema.parse(value);
  if (actor.kind !== 'human') throw new AppError(403, '후속 Work 승인은 사용자가 직접 해야 해요.');
  return operation(db, actor, input.operation_id, {action:'approve_candidate',...input}, async tx => {
    const work = await getRecord(tx, projectId(actor), input.work_id);
    if (work.kind !== 'work' || work.state !== 'candidate' || work.version !== input.expected_version) throw new AppError(409, '현재 후보와 버전을 다시 확인해 주세요.');
    const after = (await tx.query<Memory>("UPDATE records SET state='ready',version=version+1,approved_at=now(),approved_by=$3,updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING *", [projectId(actor),work.id,actor.id])).rows[0];
    await audit(tx, actor, 'record', {...after,topic_ids:work.topic_ids}, input.operation_id, '사용자가 후속 작업 후보를 승인했어요.');
    await tx.query('UPDATE topics SET context_version=context_version+1 WHERE project_id=$1 AND id=ANY($2::text[])',[projectId(actor),work.topic_ids]);
    return {work_id:work.id,version:after.version,state:after.state};
  });
}
