# Developlog MCP contract

Contract version: `3.0.1`. Endpoint: `https://developlog.spiritflag.work/mcp`.

This document describes server behavior. Tool annotations are metadata, not permissions or instructions to bypass a client's confirmation policy. The client may still ask the user to confirm an authorized operation.

## Authentication and scope

All tool calls use the existing Clerk OAuth authentication and the configured `DEVELOPLOG_OWNER_ID`. The token must identify that owner; absent identity fails with 401, a different owner or missing owner configuration with 403. Project access additionally checks `projects.owner_id`. Every project-scoped query and mutation uses the supplied `project_id`; links and evidence must belong to that project. `create_project` creates a project owned by the authenticated caller. MCP callers always have the `ai` actor kind and cannot approve candidate Work.

OAuth discovery remains at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. The protected resource advertises `openid`, `profile`, `email`. These identity scopes are **not separate read/write capabilities**. The current server does not enforce tool-specific OAuth scopes, and this release does not add scopes, change issuer/resource URLs, rotate credentials or require reauthorization. The existing token-verification wrapper is unchanged.

The closed domain of interaction is this service's project database. Tools do not fetch source URLs, import repositories, call an LLM, run Work, deploy code or contact external services. Clerk's authentication/discovery infrastructure and PostgreSQL transport are infrastructure dependencies; this is not an offline-service claim.

## Tool inventory

`project_id` is required except on `list_projects`. UUID project IDs, bounds, discriminated command variants and defaults are published in `tools/list.inputSchema`. The implementation sources are `web/lib/mcp-server.ts`, `model.ts`, `activity-model.ts`, `activity-read.ts` and `write-service.ts`. No tool names or top-level input arguments were added or removed in 3.0.1.

| Tool | Inputs (besides project_id) | JSON text result | Effects |
| --- | --- | --- | --- |
| `list_projects` | `cursor?`, `limit` (default 12, max 30) | `items`, `next_cursor` | Owner's project metadata only |
| `read_context` | `target`: project/topic/work/topics/records; `id?`; record filters and pagination below | Project overview; Topic memory and related cards; Work handoff; or `items`, `next_cursor` | Read only; derived blocked state does not write |
| `read_record` | `type`: record/topic_detail/revisions/revision/source; `id`; `entity_type?`; pagination; `offset=0`, `source_limit=8000` (max 16000) | Record with sources/relations/read_set; extended Topic; revision index/snapshot; or source text with `next_offset` | Read only, including source text; URLs never fetched |
| `search_memory` | `query` (1–120 chars), `topic_id?`, pagination | Compact `items`, `next_cursor` | Read only; searches stored Topic and Work/context/event content |
| `list_activities` | `status?`: pending/applied/superseded; `topic_id?`, `work_id?`, pagination | Activity cards, `next_cursor` | Read only |
| `read_activity` | `id` | `activity`, `attempts` (latest 10), `corrections` (up to 30), `notice` | Read only; original payload plus current application metadata |
| `list_history` | `date?` (YYYY-MM-DD), `topic_id?`, pagination | `timezone`, `items`, `next_cursor` | Read only; project-local date and linked Activity memory status |
| `create_project` | `project_id` UUID, `name`; optional `description`, `purpose`, `mode=handoff`, `timezone=Asia/Seoul`, `github_repository?` | Project metadata | Adds a project only; repository name is stored metadata |
| `commit_changes` | `operation_id` UUID, `read_set`, `changes` (1–30), `reason`, `sources=[]` (max 10) | `updated`, `read_set`, `revision` | Atomic Topic/record maintenance, sources, revisions and operation audit |
| `submit_activity` | Execution, evidence and proposals below | New: `activity_id`, `duplicate=false`, `memory_status`, `memory_version`, `conflicts`, `history_id`, `follow_up_work_ids`; duplicate execution: ID, `duplicate=true`, memory status/version | Activity plus explicitly supplied memory/Work/History/follow-up/correction effects |
| `reconcile_activity` | `operation_id`, `activity_id`, `expected_memory_version`, `memory` | `activity_id`, `status`, `memory_version`, `conflicts`; on application, `updated`, `work` | Retries pending memory, audits attempt; may apply linked Work and original correction effects |

Record filters on `read_context`: `kind=work|context|event`, `states`, `topic_id`, `from`/`to` datetimes, `from_date`/`to_date`, `cursor`, `limit`. `id` is required for topic/work targets. Each overview section has its own continuation. Work handoff has `work_version`, `read_set`, recommendation and bounded Topic detail; follow `has_more`/continuations. Read responses do not imply the stored claims were independently verified.

Successful results retain the existing `content: [{type: "text", text: JSON.stringify(result)}]` format. No `outputSchema` or `structuredContent` migration is introduced. Service errors return `isError: true` and JSON text with `error`, `status`, optional `details`. SDK input validation can return its standard tool error before the service callback; clients must inspect `isError` and must not assume every error has the same JSON body. Typical statuses: 400 invalid proposal/evidence, 401/403 authorization, 404 scoped item absent, 409 stale version/ID mismatch, 413 oversized submission, 503 unexpected failure.

## Standard annotations

| Group | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| --- | --- | --- | --- | --- |
| Seven read tools | true | false | omitted (not relevant to reads) | false |
| `create_project` | false | false | true | false |
| `commit_changes`, `submit_activity`, `reconcile_activity` | false | true | true | false |

`destructiveHint=false` means additive updates only. The three update tools may replace current memory, change Work states, retract a confirmation or mark History corrected. They therefore use `true`, even though original sources, execution reports and audit snapshots remain immutable. A result-only Activity call is narrower than the entire tool's capability; static annotations cannot describe per-call risk. Do not disguise these update tools as read-only or additive to avoid confirmation.

Idempotency means identical arguments cause no further mutation, not that every later response must contain current state. Read back current memory after a cached write response. `openWorldHint=false` reflects database memory operations, not trust in user-supplied text. See the [MCP ToolAnnotations specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts).

## Choose the smallest applicable write

Use `submit_activity` for an execution report, with or without Work. Use `commit_changes` for planning Work, initial Topic setup and deliberate maintenance. `submit_activity.memory.changes` contains only Topic command variants. It cannot perform arbitrary `save_record` operations. Previously runtime validation already rejected `save_record`; 3.0.1 removes that misleading option from the published schema as well. Existing valid calls remain valid.

Topic commands: `save_topic`, `set_design`, `report_actual`, `confirm_actual`, `set_gap`, `retract_actual`, `clear_report`. Each carries a `topic_id` and `expected_version`; rule commands also have `rule_id`. Activity commands operate on existing Topics listed in `topic_ids`. New Topic setup uses `commit_changes`.

`commit_changes` additionally supports `save_record` for Work/context/event. It replaces the record rather than patching omitted fields: read and preserve content, links, evidence, acceptance criteria and recommendation when updating. `set_design` changes intent, `report_actual` preserves confirmed Actual, `confirm_actual` needs matching evidence, and `set_gap` states the remaining difference. Retraction/clearing requires reasons and sources. `commit_changes` cannot newly mark Work done; verified completion goes through Activity. It cannot turn an AI candidate into approved Work.

Minimal result-only submission, using fresh UUIDs for a new result and stable values for a retry:

```json
{
  "project_id": "11111111-1111-4111-8111-111111111111",
  "operation_id": "22222222-2222-4222-8222-222222222222",
  "result_key": "example-execution-001",
  "channel": "connected",
  "topic_ids": [],
  "summary": "Recorded a bounded local check",
  "result": "The local check ran. No deployed behavior was verified.",
  "occurred_at": "2026-10-13T00:00:00.000Z",
  "memory": {
    "read_set": [],
    "changes": [],
    "reason": "No change to current Topic memory or Work state"
  }
}
```

Optional fields default to `work_id=null`, `sources=[]`, `verification=[]`, `memory.work_result=null`, `history=null`, `follow_ups=[]`, `correction=null`. This form creates an Activity, a memory-attempt audit, an operation record and advances the project's revision. It does not change Topic content, Work or History. Use genuine evidence only; a report is not proof that a test passed.

## Activity proposal and side effects

Execution input: `operation_id`, `result_key`, `channel=connected|handoff`, `work_id?`, `topic_ids` (max 20), `summary` (max 500), `result` (max 20000), `occurred_at`, `sources` (max 20), `verification` (max 40). A source stores UUID, title, body, origin, optional URL/ref/observation time. Verification names a source, method, scope, target, observation time, outcome and a submission-local evidence ID. Source and evidence ownership is checked; source contents cannot be overwritten.

`memory` contains `read_set` (Topic ID/context_version), Topic `changes` (max 30), `reason`, and optional `work_result`. Each changed entity's expected_version is the pre-batch version. `work_result` names `expected_version`, a conclusion (`incomplete`, `reported_complete`, `verified_complete`) and criterion checks. Only verified_complete can change the linked Work to done, after matching every saved acceptance criterion to observed/passed evidence and checking prerequisites. Other conclusions leave its state unchanged. Completion also advances related Topic context versions.

| Supplied proposal | Actual effects |
| --- | --- |
| Topic changes | Changes listed existing Topic memory and appends revisions; confirmed observations require valid evidence. No unrelated Topic content changes |
| Verified Work result | May change linked Work to done, append its revision and invalidate related Topic handoff context |
| `history` | Creates a linked event with significance (design/behavior/correction/milestone), summary, reason, Topic IDs and evidence IDs. Omit for routine tests with no meaningful change |
| `follow_ups` | Observed failures/problems create candidate Work with scope, issue key, criteria and model recommendation, or reuse an existing same-project Work/issue alias. Candidates are not approved or executed |
| `correction` | Links an original same-project Activity and reason. Once memory applies, an original pending Activity becomes superseded and its published History becomes corrected, with audit snapshots preserved |

History and follow-up Topics must stay within Activity `topic_ids`. Topic proposals use the same scope. Completing a linked Work additionally requires current context for all its related Topics. Follow-up evidence must describe an observed problem, not an invented future task. Sol/Astra and Light/Medium/High/Extra High/Ultra recommendations remain advisory; no models run or switch on the server.

## Transactions, conflicts and retries

- Ownership checks precede idempotency lookup. Writes serialize on the selected project and cache the successful operation's request hash/result. Same operation ID with a different request returns 409. Exact retry returns the original response without new audit rows or revision increments.
- `create_project` uses project_id and matching settings for idempotency. Reuse with different settings fails, and another owner's project is inaccessible.
- A new operation submitting an already stored execution (matching result_key or normalized execution hash) returns duplicate=true without another Activity, Topic/Work change, History or follow-up. It still records that new operation and advances project revision. Changing a proposal under a duplicate execution does **not** apply it; use reconciliation or a new correction as appropriate.
- Execution identity excludes transport operation/result IDs, channel, memory, History and follow-ups; normalized source/evidence content participates. Preserve the original execution and result_key for retries. Changed execution under the same result_key fails with 409.
- A Topic/Work version conflict within memory application rolls back that whole memory proposal to a savepoint, but saves the Activity, sources, evidence and a pending attempt. Requested History and follow-ups can still be saved. Therefore pending is a successful report save, **not** an all-or-nothing failure of submission. History exposes memory_status to avoid implying the memory was applied.
- Other validation failures roll back the entire submission, including sources/Activity/operation audit. If no operation was committed, a corrected request can reuse the ID. If the network outcome is unknown, retry the exact original request first.
- To reconcile pending memory, read Activity and current Topics/Work, then submit a new operation ID, expected_memory_version and current read_set/entity versions. The original execution/evidence remains immutable. A conflict inside the proposal writes a new pending attempt; a stale expected_memory_version fails with 409 before that attempt. A successful retry does not recreate History or follow-ups; its original correction can change existing History state. Applied/superseded Activities require a new correction Activity.

## User intent, confirmation and compatibility

Routine user-requested result recording and bounded updates do not require a server-generated blanket maintenance permission. Choose only the necessary fields. Clarify ambiguous project/scope first. Request explicit user intent before retracting confirmed memory, clearing reports, correcting previous results, replacing substantive memory, or cancelling/reopening Work. These conversational rules are not an additional server-enforced permission system.

Candidate approval is different: the server enforces a human actor and authenticated same-origin UI action. No MCP approval tool or approval boolean is introduced. OAuth, ownership, versions and evidence checks remain in force regardless of a client's tool hints or confirmation UI.

After deployment, refresh the connected client's tool catalog and confirm all 11 tools appear. An old six-tool catalog cannot call the five Activity/History tools even when the server already supports them. Catalog refresh, existing-token acceptance, a new OAuth authorization-code flow and refresh-token rotation are distinct checks. A successful call over an existing connection proves only that connection worked at that time. Do not claim fresh OAuth/refresh behavior without testing it, and do not attribute a client's remaining confirmation prompts to a server failure.
