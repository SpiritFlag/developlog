import { z } from "zod";
import { recommendationSchema } from "./work-recommendation";

export const idSchema = z.string().min(1).max(120);
export const pageSchema = z.object({
  cursor: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(30).default(12),
});
export const projectIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const shortText = z.string().trim().min(1).max(1200);
export const criterionSchema = z.object({
  id: idSchema, text: shortText,
  required_method: z.enum(['code_read','automated_test','user_observation']),
}).strict();
export const evidenceSchema = z
  .object({
    source_id: idSchema,
    method: z.enum([
      "documented",
      "code_read",
      "automated_test",
      "user_observation",
    ]),
    scope: z.string().trim().min(1).max(400),
    target: z.string().trim().min(1).max(300),
    observed_at: z.string().datetime().nullable(),
  })
  .strict();
export const designSchema = z
  .object({
    text: shortText,
    reason: z.string().max(600).default(""),
    source_ids: z.array(idSchema).max(8).default([]),
  })
  .strict();
export const actualSchema = z
  .object({ text: shortText, evidence: z.array(evidenceSchema).min(1).max(5) })
  .strict();
export const gapSchema = z
  .object({
    state: z.enum(["aligned", "temporary", "planned", "unknown"]),
    reason: z.string().max(600),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export type Rule = {
  id: string;
  title: string;
  design: (z.infer<typeof designSchema> & { version: number }) | null;
  actual: (z.infer<typeof actualSchema> & { version: number }) | null;
  reported: {
    text: string;
    source_ids: string[];
    target: string;
    reported_at: string;
  } | null;
  gap: z.infer<typeof gapSchema> & {
    design_version: number;
    actual_version: number;
  };
};
export type Topic = {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  intro: string;
  aliases: string[];
  rules: Rule[];
  detail: string;
  source_ids: string[];
  version: number;
  context_version: number;
  position: number;
  updated_at: string;
};
export type TopicCard = Pick<
  Topic,
  | "id"
  | "title"
  | "slug"
  | "intro"
  | "version"
  | "context_version"
  | "position"
  | "updated_at"
> & {
  current: string | null;
  signals: {
    title: string;
    state: string;
    reason: string;
    reported: boolean;
  }[];
};
export const recordKinds = [
  "work",
  "context",
  "event",
] as const;
export const recordStates = {
  work: ["candidate", "ready", "active", "blocked", "done", "cancelled"],
  idea: ["open", "archived"],
  context: ["active", "resolved"],
  event: ["published", "corrected"],
  note: ["inbox", "processed", "archived"],
} as const;
export const recordInputSchema = z
  .object({
    kind: z.enum(recordKinds),
    title: z.string().trim().min(1).max(160),
    summary: z.string().max(500).default(""),
    body: z.string().max(12000).default(""),
    state: z.string().max(30),
    topic_ids: z.array(idSchema).max(10).default([]),
    source_ids: z.array(idSchema).max(20).default([]),
    acceptance: z.string().max(2000).default(""),
    acceptance_criteria: z.array(criterionSchema).max(30).default([]),
    recommendation: recommendationSchema.nullable().default(null),
    issue_key: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9:_/-]*$/).nullable().default(null),
    resolution: z.string().max(1200).default(""),
    reason: z.string().max(1200).default(""),
    depends_on: z.array(idSchema).max(12).default([]),
    derived_from: z.array(idSchema).max(12).default([]),
    parent_id: idSchema.nullable().default(null),
    evidence: z.array(evidenceSchema).max(40).default([]),
    occurred_at: z.string().datetime().nullable().default(null),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.acceptance_criteria.map(c => c.id)).size !== r.acceptance_criteria.length)
      ctx.addIssue({ code: 'custom', message: '완료 조건 ID는 중복될 수 없어요.' });
    if (r.kind !== 'work' && (r.acceptance_criteria.length || r.recommendation || r.issue_key))
      ctx.addIssue({ code: 'custom', message: '작업 설정은 Work에만 연결해요.' });
    if (!(recordStates[r.kind] as readonly string[]).includes(r.state))
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "종류에 맞지 않는 상태예요.",
      });
    if (
      r.kind !== "work" &&
      (r.depends_on.length || r.parent_id || r.acceptance)
    )
      ctx.addIssue({
        code: "custom",
        message: "작업 관계는 Work에만 연결해요.",
      });
    if (r.kind === "event" && (!r.occurred_at || !r.reason))
      ctx.addIssue({
        code: "custom",
        message: "변화에는 발생 시점과 이유가 필요해요.",
      });
    if (r.kind === "context" && r.state === "active" && !r.resolution)
      ctx.addIssue({
        code: "custom",
        message: "현재 사정의 해제 또는 재검토 조건을 남겨 주세요.",
      });
  });
export type RecordInput = z.infer<typeof recordInputSchema>;
export type Memory = Omit<RecordInput, "kind"> & {
  activity_id?: string | null;
  project_timezone?: string;
  generated_by_activity?: string | null;
  approved_at?: string | null;
  // Archived revision snapshots retain their original kinds.
  kind: RecordInput["kind"] | "idea" | "note";
  id: string;
  project_id: string;
  version: number;
  created_at: string;
  updated_at: string;
};
export type RecordCard = Pick<
  Memory,
  | "id"
  | "kind"
  | "title"
  | "summary"
  | "state"
  | "version"
  | "occurred_at"
  | "updated_at"
  | "topic_ids"
  | "resolution"
  | "reason"
> & { project_timezone?: string; stored_state?: string; waiting_for?: { id: string; title: string; state: string }[] };
export type Project = {
  id: string;
  name: string;
  description: string;
  revision: number;
  updated_at: string;
  github_repository: string | null;
  purpose: string;
  mode: "connected" | "handoff";
  timezone: string;
};
export type Actor = { id: string; kind: "human" | "ai"; projectId?: string };
export type SourceMeta = {
  id: string;
  title: string;
  origin: string;
  url: string | null;
  ref: string | null;
  observed_at: string;
  captured_by: string | null;
};
export type Page<T> = { items: T[]; next_cursor: string | null };
export type ProjectCurrent = {
  project: Project;
  topics: Page<TopicCard>;
  context: Page<RecordCard>;
  active_work: Page<RecordCard>;
  ready_work: Page<RecordCard>;
  blocked_work: Page<RecordCard>;
  recent: Page<RecordCard>;
  candidate_work: Page<RecordCard>;
  pending_activities: Page<{id:string;summary:string}>;
};
export type TopicCurrent = {
  project: Project;
  topic: Topic;
  context: Page<RecordCard>;
  work: Page<RecordCard>;
  sources: SourceMeta[];
};
export const readSetSchema = z
  .array(
    z
      .object({
        topic_id: idSchema,
        context_version: z.number().int().positive(),
      })
      .strict(),
  )
  .max(20);
export const sourceInputSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    body: z.string().min(1).max(200000),
    origin: z.enum([
      "intent",
      "report",
      "document",
      "code",
      "test",
      "observation",
    ]),
    url: z
      .string()
      .url()
      .regex(/^https?:\/\//)
      .nullable()
      .default(null),
    ref: z.string().max(300).nullable().default(null),
    observed_at: z.string().datetime().nullable().default(null),
  })
  .strict();
const topicChange = {
  topic_id: idSchema,
  expected_version: z.number().int().nonnegative(),
};
const ruleChange = { ...topicChange, rule_id: idSchema };
export const topicChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type:z.literal('retract_actual'), ...ruleChange,
    reason:shortText, source_ids:z.array(idSchema).min(1).max(8),
  }).strict(),
  z.object({
    type:z.literal('clear_report'), ...ruleChange,
    reason:shortText, source_ids:z.array(idSchema).min(1).max(8),
  }).strict(),
  z
    .object({
      type: z.literal("save_topic"),
      ...topicChange,
      title: z.string().trim().min(1).max(100),
      slug: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9-]+$/),
      intro: z.string().max(500),
      aliases: z.array(z.string().max(80)).max(10).default([]),
      detail: z.string().max(12000).optional(),
      source_ids: z.array(idSchema).max(20).optional(),
      position: z.number().int().min(0).max(999).default(50),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_design"),
      ...ruleChange,
      title: z.string().trim().min(1).max(100),
      design: designSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("report_actual"),
      ...ruleChange,
      text: shortText,
      source_ids: z.array(idSchema).min(1).max(8),
      target: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal("confirm_actual"),
      ...ruleChange,
      actual: actualSchema,
      resolves_report: z.boolean().default(false),
    })
    .strict(),
  z
    .object({ type: z.literal("set_gap"), ...ruleChange, gap: gapSchema })
    .strict(),
]);
export const changeSchema = z.discriminatedUnion("type", [
  ...topicChangeSchema.options,
  z
    .object({
      type: z.literal("save_record"),
      id: idSchema,
      expected_version: z.number().int().nonnegative(),
      record: recordInputSchema,
    })
    .strict(),
]);
export const commitSchema = z
  .object({
    operation_id: z.string().uuid(),
    read_set: readSetSchema,
    sources: z.array(sourceInputSchema).max(10).default([]),
    changes: z.array(changeSchema).min(1).max(30),
    reason: z.string().trim().min(1).max(1200),
  })
  .strict();
export const labels: Record<string, string> = {
  candidate: "후속 작업 후보",
  ready: "이어갈 일",
  active: "진행 중",
  blocked: "기다리는 중",
  done: "완료",
  cancelled: "하지 않기로 함",
  open: "생각 중",
  archived: "보관",
  resolved: "해소됨",
  published: "변화",
  corrected: "바로잡음",
  inbox: "아직 정리 전",
  processed: "정리됨",
  aligned: "설계와 일치",
  temporary: "임시 유지",
  planned: "변경 예정",
  unknown: "확인 필요",
  documented: "문서 기록",
  code_read: "코드 확인",
  automated_test: "자동 시험 기록",
  user_observation: "사용자 관찰 기록",
  work: "할 일",
  idea: "생각",
  context: "알아둘 것",
  event: "지나온 변화",
  note: "메모",
};
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
