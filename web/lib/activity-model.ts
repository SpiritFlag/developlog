import { z } from "zod";
import { topicChangeSchema, criterionSchema, evidenceSchema, idSchema, readSetSchema, sourceInputSchema } from "./model";
import { recommendationSchema } from "./work-recommendation";

const text = z.string().trim().min(1).max(1200);
export const verificationSchema = evidenceSchema.extend({
  id: idSchema,
  outcome: z.enum(['passed','failed','observed','not_run']),
}).strict();
export const workResultSchema = z.object({
  expected_version: z.number().int().positive(),
  conclusion: z.enum(['incomplete','reported_complete','verified_complete']),
  checks: z.array(z.object({
    criterion_id: idSchema, satisfied: z.boolean(),
    evidence_ids: z.array(idSchema).max(10), note: text,
  }).strict()).max(30),
}).strict();
export const memoryProposalSchema = z.object({
  read_set: readSetSchema,
  // Encode the boundary in JSON Schema too, not only an invisible runtime refinement.
  changes: z.array(topicChangeSchema).max(30)
    .describe('Commands for existing Topics in topic_ids only. No save_record; Work uses work_result or follow_ups. Empty when memory is unchanged.'),
  work_result: workResultSchema.nullable().default(null),
  reason: text,
}).strict();
export const followUpSchema = z.object({
  issue_key: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9:_/-]*$/),
  existing_work_id: idSchema.nullable().default(null),
  title: z.string().trim().min(1).max(160),
  problem: text, scope: text,
  evidence_ids: z.array(idSchema).min(1).max(10),
  topic_ids: z.array(idSchema).max(10),
  acceptance_criteria: z.array(criterionSchema).min(1).max(30),
  recommendation: recommendationSchema,
}).strict();
export const submitActivitySchema = z.object({
  operation_id: z.string().uuid(),
  result_key: z.string().trim().min(1).max(160),
  channel: z.enum(['connected','handoff']),
  work_id: idSchema.nullable().default(null),
  topic_ids: z.array(idSchema).max(20),
  summary: z.string().trim().min(1).max(500),
  result: z.string().trim().min(1).max(20000),
  occurred_at: z.string().datetime(),
  sources: z.array(sourceInputSchema).max(20).default([]),
  verification: z.array(verificationSchema).max(40).default([]),
  memory: memoryProposalSchema,
  history: z.object({
    significance: z.enum(['design','behavior','correction','milestone']),
    summary: z.string().trim().min(1).max(300), reason: text,
    topic_ids: z.array(idSchema).max(20), evidence_ids: z.array(idSchema).min(1).max(20),
  }).strict().nullable().default(null),
  follow_ups: z.array(followUpSchema).max(10).default([]),
  correction: z.object({ activity_id: idSchema, reason: text }).strict().nullable().default(null),
}).strict();
export const reconcileActivitySchema = z.object({
  operation_id: z.string().uuid(), activity_id: idSchema,
  expected_memory_version: z.number().int().positive(), memory: memoryProposalSchema,
}).strict();
export type ActivityInput = z.infer<typeof submitActivitySchema>;
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;
export type Activity = {
  id: string; project_id: string; result_key: string; result_hash: string;
  work_id: string | null; summary: string; result: string; occurred_at: string;
  payload: ActivityInput; memory_status: 'pending' | 'applied' | 'superseded'; memory_version: number;
  conflicts: unknown[]; corrects_activity_id: string | null; created_at: string;
};
