import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Executor } from "./db";
import {
  AppError,
  commitSchema,
  recordInputSchema,
  type Actor,
  type Evidence,
  type Memory,
  type Project,
  type Topic,
  type Rule,
} from "./model";
import { project, projectId, getRecord } from "./service";

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export async function operation<T>(
  db: Database,
  actor: Actor,
  id: string,
  value: unknown,
  fn: (tx: Executor, p: Project) => Promise<T>,
) {
  const hash = createHash("sha256").update(canonical(value)).digest("hex");
  return db.transaction(async (tx) => {
    const p = await project(tx, actor, true);
    const prior = (
      await tx.query<{ actor_id: string; request_hash: string; result: T }>(
        "SELECT actor_id,request_hash,result FROM operations WHERE project_id=$1 AND id=$2",
        [p.id, id],
      )
    ).rows[0];
    if (prior) {
      if (prior.actor_id !== actor.id || prior.request_hash !== hash)
        throw new AppError(409, "같은 요청 ID의 내용이 달라요.");
      return prior.result;
    }
    const result = JSON.parse(JSON.stringify(await fn(tx, p))) as T;
    await tx.query(
      "UPDATE projects SET revision=revision+1,updated_at=now() WHERE id=$1",
      [p.id],
    );
    await tx.query(
      "INSERT INTO operations(id,project_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5)",
      [id, p.id, actor.id, hash, JSON.stringify(result)],
    );
    return result;
  });
}
export async function validateSources(tx: Executor, pid: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = (
    await tx.query(
      "SELECT id FROM sources WHERE project_id=$1 AND id=ANY($2::text[])",
      [pid, unique],
    )
  ).rows;
  if (found.length !== unique.length)
    throw new AppError(400, "연결한 원문이 이 프로젝트에 없어요.");
}
export async function validateEvidence(
  tx: Executor,
  pid: string,
  evidence: Evidence[],
) {
  await validateSources(
    tx,
    pid,
    evidence.map((e) => e.source_id),
  );
  const rows = (
    await tx.query<{ id: string; origin: string }>(
      "SELECT id,origin FROM sources WHERE project_id=$1 AND id=ANY($2::text[])",
      [pid, evidence.map((e) => e.source_id)],
    )
  ).rows;
  const origins: Record<string, string[]> = {
    documented: ["document", "legacy"],
    code_read: ["code"],
    automated_test: ["test"],
    user_observation: ["observation"],
  };
  for (const e of evidence)
    if (
      !origins[e.method].includes(
        rows.find((s) => s.id === e.source_id)!.origin,
      )
    )
      throw new AppError(
        400,
        "의도나 구현 보고를 확인 근거로 바꿀 수 없어요. 문서·코드·시험·관찰 범위를 구분해 주세요.",
      );
}
export async function audit(
  tx: Executor,
  actor: Actor,
  type: "topic" | "record",
  value: Topic | Memory,
  operationId: string,
  reason: string,
) {
  await tx.query(
    "INSERT INTO knowledge_revisions(project_id,id,entity_type,entity_id,version,snapshot,reason,actor_id,actor_kind,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      projectId(actor),
      randomUUID(),
      type,
      value.id,
      value.version,
      JSON.stringify(value),
      reason,
      actor.id,
      actor.kind,
      operationId,
    ],
  );
}
export async function storeRecord(
  tx: Executor,
  pid: string,
  id: string,
  version: number,
  input: z.infer<typeof recordInputSchema>,
) {
  const r = recordInputSchema.parse(input);
  const row = (
    await tx.query<Memory>(
      `INSERT INTO records(project_id,id,kind,title,summary,body,state,acceptance,resolution,reason,depends_on,derived_from,parent_id,source_ids,evidence,version,occurred_at,acceptance_criteria,recommendation,issue_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT(project_id,id) DO UPDATE SET title=EXCLUDED.title,summary=EXCLUDED.summary,body=EXCLUDED.body,state=EXCLUDED.state,acceptance=EXCLUDED.acceptance,resolution=EXCLUDED.resolution,reason=EXCLUDED.reason,depends_on=EXCLUDED.depends_on,derived_from=EXCLUDED.derived_from,parent_id=EXCLUDED.parent_id,source_ids=EXCLUDED.source_ids,evidence=EXCLUDED.evidence,version=EXCLUDED.version,occurred_at=EXCLUDED.occurred_at,acceptance_criteria=EXCLUDED.acceptance_criteria,recommendation=EXCLUDED.recommendation,issue_key=EXCLUDED.issue_key,updated_at=now() RETURNING *`,
      [
        pid,
        id,
        r.kind,
        r.title,
        r.summary,
        r.body,
        r.state,
        r.acceptance,
        r.resolution,
        r.reason,
        JSON.stringify(r.depends_on),
        JSON.stringify(r.derived_from),
        r.parent_id,
        JSON.stringify(r.source_ids),
        JSON.stringify(r.evidence),
        version,
        r.occurred_at,
        JSON.stringify(r.acceptance_criteria),
        JSON.stringify(r.recommendation),
        r.issue_key,
      ],
    )
  ).rows[0];
  await tx.query(
    "DELETE FROM record_topics WHERE project_id=$1 AND record_id=$2",
    [pid, id],
  );
  for (const topicId of new Set(r.topic_ids))
    await tx.query(
      "INSERT INTO record_topics(project_id,record_id,topic_id) VALUES($1,$2,$3)",
      [pid, id, topicId],
    );
  return { ...row, topic_ids: [...new Set(r.topic_ids)] };
}
export async function commitChanges(
  db: Database,
  actor: Actor,
  input: unknown,
) {
  const m = commitSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(m)) > 500000)
    throw new AppError(
      413,
      "변경 묶음이 너무 커요. 관련 주제별로 나눠 주세요.",
    );
  return operation(
    db,
    actor,
    m.operation_id,
    { action: "commit", ...m },
    async (tx, p) => {
      const topics = new Map<string, Topic>();
      const initialVersions = new Map<string, number>();
      const originals = new Map<string, string>();
      const affected = new Set<string>(),
        changed = new Set<string>();
      for (const basis of m.read_set) {
        const t = (
          await tx.query<Topic>(
            "SELECT * FROM topics WHERE project_id=$1 AND id=$2",
            [p.id, basis.topic_id],
          )
        ).rows[0];
        if (!t || t.context_version !== basis.context_version)
          throw new AppError(
            409,
            "주제의 설계나 작업 맥락이 바뀌었어요. 관련 주제를 다시 읽어 주세요.",
            {
              topic_id: basis.topic_id,
              context_version: t?.context_version ?? null,
            },
          );
        topics.set(t.id, t);
        initialVersions.set(t.id, t.version);
        originals.set(t.id, canonical(t));
      }
      const requireTopic = (id: string) => {
        const t = topics.get(id);
        if (!t)
          throw new AppError(
            409,
            "영향받는 주제를 먼저 읽고 read_set에 포함해 주세요.",
            { topic_id: id },
          );
        affected.add(id);
        return t;
      };
      for (const s of m.sources) {
        await tx.query(
          "INSERT INTO sources(id,project_id,kind,title,body,url,ref,origin,captured_by,observed_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz,now()),$11)",
          [
            s.id,
            p.id,
            actor.kind,
            s.title,
            s.body,
            s.url,
            s.ref,
            s.origin,
            actor.kind,
            s.observed_at,
            JSON.stringify({ actor: actor.id }),
          ],
        );
      }
      const updated: { type: string; id: string; version: number }[] = [];
      const recordChanges = m.changes.filter((c) => c.type === "save_record");
      if (new Set(recordChanges.map((c) => c.id)).size !== recordChanges.length)
        throw new AppError(400, "같은 기록의 변경은 한 번에 묶어 주세요.");
      for (const c of m.changes) {
        if (c.type === "save_record") continue;
        let t = topics.get(c.topic_id);
        if (c.type === "save_topic" && c.expected_version === 0) {
          if (
            t ||
            (
              await tx.query(
                "SELECT id FROM topics WHERE project_id=$1 AND id=$2",
                [p.id, c.topic_id],
              )
            ).rows.length
          )
            throw new AppError(
              409,
              "이미 있는 주제예요. 현재 버전을 읽어 주세요.",
            );
          t = {
            id: c.topic_id,
            project_id: p.id,
            title: c.title,
            slug: c.slug,
            intro: c.intro,
            aliases: c.aliases,
            position: c.position,
            detail: c.detail ?? "",
            source_ids: c.source_ids ?? [],
            rules: [],
            version: 0,
            context_version: 0,
            updated_at: new Date().toISOString(),
          };
          topics.set(t.id, t);
          initialVersions.set(t.id, 0);
        }
        t = requireTopic(c.topic_id);
        if (initialVersions.get(t.id) !== c.expected_version)
          throw new AppError(409, "주제 버전이 바뀌었어요.", {
            topic_id: t.id,
            version: initialVersions.get(t.id),
          });
        changed.add(t.id);
        if (c.type === "save_topic") {
          Object.assign(t, {
            title: c.title,
            slug: c.slug,
            intro: c.intro,
            aliases: c.aliases,
            position: c.position,
          });
          if (c.detail !== undefined) t.detail = c.detail;
          if (c.source_ids !== undefined) {
            await validateSources(tx, p.id, c.source_ids);
            t.source_ids = c.source_ids;
          }
          continue;
        }
        let r = t.rules.find((r) => r.id === c.rule_id);
        if (!r && c.type === "set_design") {
          if (t.rules.length >= 12)
            throw new AppError(
              400,
              "주제의 핵심 규칙은 12개까지예요. 상세 규칙이나 별도 주제로 나눠 주세요.",
            );
          r = {
            id: c.rule_id,
            title: c.title,
            design: null,
            actual: null,
            reported: null,
            gap: {
              state: "unknown",
              reason: "실제 상태를 아직 확인하지 않았어요.",
              design_version: 0,
              actual_version: 0,
            },
          };
          t.rules.push(r);
        }
        if (!r) throw new AppError(404, "설계 항목을 먼저 만들어 주세요.");
        if (c.type === "set_design") {
          await validateSources(tx, p.id, c.design.source_ids);
          if (r.title === c.title && r.design && canonical({ text: r.design.text, reason: r.design.reason, source_ids: r.design.source_ids }) === canonical(c.design)) continue;
          r.title = c.title;
          r.design = { ...c.design, version: (r.design?.version ?? 0) + 1 };
          r.gap = {
            state: "unknown",
            reason: "설계가 바뀌어 실제 상태와 다시 대조해야 해요.",
            design_version: r.design.version,
            actual_version: r.actual?.version ?? 0,
          };
        } else if (c.type === "report_actual") {
          await validateSources(tx, p.id, c.source_ids);
          if (r.reported && canonical({ text: r.reported.text, source_ids: r.reported.source_ids, target: r.reported.target }) === canonical({ text: c.text, source_ids: c.source_ids, target: c.target })) continue;
          r.reported = {
            text: c.text,
            source_ids: c.source_ids,
            target: c.target,
            reported_at: new Date().toISOString(),
          };
        } else if (c.type === "confirm_actual") {
          await validateEvidence(tx, p.id, c.actual.evidence);
          if (r.actual && canonical({ text: r.actual.text, evidence: r.actual.evidence }) === canonical(c.actual) && (!c.resolves_report || !r.reported)) continue;
          const latestOld = Math.max(
            0,
            ...(r.actual?.evidence ?? []).map((e) =>
              e.observed_at ? Date.parse(e.observed_at) : 0,
            ),
          );
          const latestNew = Math.max(
            0,
            ...c.actual.evidence.map((e) =>
              e.observed_at ? Date.parse(e.observed_at) : 0,
            ),
          );
          if (latestOld && latestNew < latestOld)
            throw new AppError(
              409,
              "더 오래된 관찰로 현재 상태를 덮을 수 없어요. 과거 변화로 보존해 주세요.",
            );
          r.actual = { ...c.actual, version: (r.actual?.version ?? 0) + 1 };
          if (c.resolves_report) r.reported = null;
          r.gap = {
            state: "unknown",
            reason: "확인 범위가 바뀌어 설계와 다시 대조해야 해요.",
            design_version: r.design?.version ?? 0,
            actual_version: r.actual.version,
          };
        } else if (c.type === 'retract_actual') {
          await validateSources(tx,p.id,c.source_ids);
          r.actual = null;
          r.gap = {state:'unknown',reason:c.reason,design_version:r.design?.version ?? 0,actual_version:0};
        } else if (c.type === 'clear_report') {
          await validateSources(tx,p.id,c.source_ids);
          r.reported = null;
        } else if (c.type === "set_gap") {
          if (c.gap.state !== "unknown" && (!r.design || !r.actual))
            throw new AppError(
              400,
              "설계와 실제 상태를 모두 알아야 차이를 정할 수 있어요.",
            );
          if (
            ["temporary", "planned"].includes(c.gap.state) &&
            !c.gap.reason.trim()
          )
            throw new AppError(400, "차이가 있는 이유를 남겨 주세요.");
          r.gap = {
            ...c.gap,
            design_version: r.design?.version ?? 0,
            actual_version: r.actual?.version ?? 0,
          };
        }
      }
      // Persist topics first so new record links have real composite foreign keys.
      for (const id of changed) {
        const t = topics.get(id)!;
        if (originals.get(id) === canonical(t)) {
          changed.delete(id);
          affected.delete(id);
          continue;
        }
        t.version = (initialVersions.get(id) ?? 0) + 1;
        await tx.query(
          `INSERT INTO topics(project_id,id,title,slug,intro,aliases,rules,detail,source_ids,version,context_version,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(project_id,id) DO UPDATE SET title=EXCLUDED.title,slug=EXCLUDED.slug,intro=EXCLUDED.intro,aliases=EXCLUDED.aliases,rules=EXCLUDED.rules,detail=EXCLUDED.detail,source_ids=EXCLUDED.source_ids,version=EXCLUDED.version,position=EXCLUDED.position,updated_at=now()`,
          [
            p.id,
            id,
            t.title,
            t.slug,
            t.intro,
            JSON.stringify(t.aliases),
            JSON.stringify(t.rules),
            t.detail,
            JSON.stringify(t.source_ids),
            t.version,
            t.context_version,
            t.position,
          ],
        );
        updated.push({ type: "topic", id, version: t.version });
      }
      for (const c of recordChanges) {
        const exists = (
          await tx.query<{ version: number }>(
            "SELECT version FROM records WHERE project_id=$1 AND id=$2",
            [p.id, c.id],
          )
        ).rows[0];
        if ((exists?.version ?? 0) !== c.expected_version)
          throw new AppError(409, "기록 버전이 바뀌었어요.", {
            id: c.id,
            version: exists?.version ?? 0,
          });
        const before = exists ? await getRecord(tx, p.id, c.id) : null;
        if (before?.generated_by_activity && !before.approved_at && !['candidate','cancelled'].includes(c.record.state))
          throw new AppError(403, '자동 생성된 Work는 approve_candidate로 사용자 승인을 받아야 해요.');
        if (actor.kind === 'ai' && before?.state === 'candidate' && !['candidate','cancelled'].includes(c.record.state))
          throw new AppError(403, '자동 생성된 Work 후보는 사용자가 승인해야 해요.');
        if (c.record.state === 'done' && before?.state !== 'done')
          throw new AppError(400, 'Work 완료는 submit_activity의 검증된 완료 조건으로 처리해 주세요.');
        if (before?.state === 'done' && c.record.state === 'done' &&
          (before.acceptance !== c.record.acceptance || canonical(before.acceptance_criteria) !== canonical(c.record.acceptance_criteria)))
          throw new AppError(400,'완료 조건을 바꾸면 Work를 다시 열고 검증해 주세요.');
        if (before && before.kind !== c.record.kind)
          throw new AppError(
            400,
            "기록 종류는 바꿀 수 없어요.",
          );
        for (const tid of new Set([
          ...(before?.topic_ids ?? []),
          ...c.record.topic_ids,
        ]))
          requireTopic(tid);
        await validateSources(tx, p.id, c.record.source_ids);
        if (c.record.evidence.length)
          await validateEvidence(tx, p.id, c.record.evidence);
        if (
          c.record.kind === "work" &&
          c.record.state === "done" &&
          !c.record.evidence.length
        )
          throw new AppError(400, "완료에는 실제 확인 범위와 근거가 필요해요.");
        const links = [
          ...c.record.depends_on,
          ...c.record.derived_from,
          ...(c.record.parent_id ? [c.record.parent_id] : []),
        ];
        if (links.includes(c.id))
          throw new AppError(400, "자기 자신을 연결할 수 없어요.");
        for (const linked of new Set(links)) {
          const target = (
            await tx.query<{ kind: string; state: string }>(
              "SELECT kind,state FROM records WHERE project_id=$1 AND id=$2",
              [p.id, linked],
            )
          ).rows[0];
          if (!target)
            throw new AppError(
              400,
              "연결한 기록이 이 프로젝트에 없어요. 새 선행 기록을 먼저 저장해 주세요.",
            );
          if (
            (c.record.depends_on.includes(linked) ||
              c.record.parent_id === linked) &&
            target.kind !== "work"
          )
            throw new AppError(
              400,
              "선행 작업과 상위 작업에는 Work를 연결해 주세요.",
            );
          if (
            c.record.depends_on.includes(linked) &&
            ["active", "done"].includes(c.record.state) &&
            target.state !== "done"
          )
            throw new AppError(400, "선행 작업이 아직 끝나지 않았어요.");
        }
        const after = await storeRecord(
          tx,
          p.id,
          c.id,
          c.expected_version + 1,
          c.record,
        );
        await audit(tx, actor, "record", after, m.operation_id, m.reason);
        updated.push({ type: "record", id: c.id, version: after.version });
      }
      // Parent hierarchy and dependencies have different meanings and separate cycle checks.
      if (recordChanges.some((c) => c.record.kind === "work")) {
        const rows = (
          await tx.query<{
            id: string;
            depends_on: string[];
            parent_id: string | null;
          }>(
            "SELECT id,depends_on,parent_id FROM records WHERE project_id=$1 AND kind='work'",
            [p.id],
          )
        ).rows;
        for (const relation of ["depends_on", "parent_id"] as const) {
          const edges = new Map(
            rows.map((r) => [
              r.id,
              relation === "depends_on"
                ? r.depends_on
                : r.parent_id
                  ? [r.parent_id]
                  : [],
            ]),
          );
          const visited = new Set<string>(),
            stack = new Set<string>();
          const visit = (id: string) => {
            if (stack.has(id)) throw new AppError(400, "작업 연결이 순환해요.");
            if (visited.has(id)) return;
            stack.add(id);
            for (const to of edges.get(id) ?? []) visit(to);
            stack.delete(id);
            visited.add(id);
          };
          for (const id of edges.keys()) visit(id);
        }
      }
      const contexts: { topic_id: string; context_version: number }[] = [];
      for (const id of affected) {
        const row = (
          await tx.query<Topic>(
            "UPDATE topics SET context_version=context_version+1,updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING *",
            [p.id, id],
          )
        ).rows[0];
        contexts.push({ topic_id: id, context_version: row.context_version });
        if (changed.has(id))
          await audit(tx, actor, "topic", row, m.operation_id, m.reason);
      }
      return { updated, read_set: contexts, revision: p.revision + 1 };
    },
  );
}
export const createProjectSchema = z
  .object({
    project_id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(""),
    purpose: z.string().trim().max(2000).default(""),
    mode: z.enum(['connected','handoff']).default('handoff'),
    timezone: z.string().max(100).default('Asia/Seoul').refine(value => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
    }, '유효한 시간대가 필요해요.'),
    github_repository: z
      .string()
      .max(140)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/)
      .optional(),
  })
  .strict();
export async function createProject(
  db: Database,
  actor: Actor,
  input: unknown,
) {
  const v = createProjectSchema.parse(input);
  return db.transaction(async (tx) => {
    if (!(await tx.query('SELECT name FROM pg_timezone_names WHERE name=$1',[v.timezone])).rows.length)
      throw new AppError(400,'Postgres가 지원하는 IANA 시간대를 선택해 주세요.');
    const inserted = (
      await tx.query<Project>(
        "INSERT INTO projects(id,name,description,owner_id,github_repository,purpose,mode,timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id,name,description,revision,updated_at,github_repository,purpose,mode,timezone",
        [
          v.project_id,
          v.name,
          v.description,
          actor.id,
          v.github_repository ?? null,
          v.purpose, v.mode, v.timezone,
        ],
      )
    ).rows[0];
    if (inserted) return inserted;
    const p = await project(tx, { ...actor, projectId: v.project_id });
    if (
      p.name !== v.name ||
      p.description !== v.description ||
      p.purpose !== v.purpose || p.mode !== v.mode || p.timezone !== v.timezone ||
      p.github_repository !== (v.github_repository ?? null)
    )
      throw new AppError(409, "같은 프로젝트 요청의 내용이 달라요.");
    return p;
  });
}
