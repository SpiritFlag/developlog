import type { Database } from "./db";
import type { Actor } from "./model";
import {
  listProjects,
  createProject,
  readProject,
  readTopic,
  listTopics,
  listRecords,
  readRecord,
  readSource,
  readRevision,
  revisionList,
  topicDetail,
  searchMemory,
  readHandoff,
  revisionCursor,
} from "./service";
import { AppError, projectIdSchema } from "./model";
import { z, ZodError } from "zod";
import { submitActivity, reconcileActivity, approveCandidate } from './activity-service';
import { listActivities, listHistory, readActivity } from './activity-read';
const headers = { "Cache-Control": "private, no-store" };
function error(e: unknown) {
  if (e instanceof AppError)
    return Response.json(
      { error: e.message, details: e.details },
      { status: e.status, headers },
    );
  if (e instanceof ZodError)
    return Response.json(
      { error: "입력 내용을 확인해 주세요.", details: e.flatten() },
      { status: 400, headers },
    );
  console.error(
    "Workspace request failed",
    e instanceof Error ? e.name : "unknown",
  );
  return Response.json(
    { error: "저장소에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요." },
    { status: 503, headers },
  );
}
// Production supplies Clerk authentication; tests supply an isolated database
// and synthetic identity to this same HTTP contract. There is no auth bypass.
export function createWorkspaceApi(database: () => Database, webActor: () => Promise<Actor>) {
async function GET(req: Request) {
  try {
    const actor = await webActor(),
      db = database(),
      q = new URL(req.url).searchParams;
    const view = q.get("view") ?? "project";
    const page = {
      cursor: q.get("cursor") ?? undefined,
      limit: q.has("limit") ? Number(q.get("limit")) : undefined,
    };
    if (view === "projects")
      return Response.json(await listProjects(db, actor, page), { headers });
    actor.projectId = projectIdSchema.parse(q.get("project"));
    const id = q.get("id") ?? "";
    let value: unknown;
    switch (view) {
      case 'activities':
        value = await listActivities(db,actor,{...page,status:q.get('status') ?? undefined,topic_id:q.get('topic') ?? undefined,work_id:q.get('work') ?? undefined});
        break;
      case 'activity':
        value = await readActivity(db,actor,id);
        break;
      case 'history':
        value = await listHistory(db,actor,{...page,date:q.get('date') ?? undefined,topic_id:q.get('topic') ?? undefined});
        break;
      case "project":
        value = await readProject(db, actor);
        break;
      case "topic":
        value = await readTopic(db, actor, id);
        break;
      case "topics":
        value = await listTopics(db, actor, page);
        break;
      case "records":
        value = await listRecords(db, actor, {
          ...page,
          kind: q.get("kind") ?? undefined,
          states: q.has("states") ? q.get("states")!.split(",") : undefined,
          topic_id: q.get("topic") ?? undefined,
          from: q.get("from") ?? undefined,
          to: q.get("to") ?? undefined,
          from_date: q.get('from_date') ?? undefined,
          to_date: q.get('to_date') ?? undefined,
        });
        break;
      case "record":
        value = await readRecord(db, actor, id);
        break;
      case "source":
        value = await readSource(db, actor, {
          id,
          offset: Number(q.get("offset") ?? 0),
        });
        break;
      case "topic_detail":
        value = await topicDetail(db, actor, id);
        break;
      case "revisions": {
        const type = q.get("type");
        if (type !== "topic" && type !== "record")
          throw new AppError(400, "이력 종류를 확인해 주세요.");
        value = await revisionList(db, actor, type, id, page);
        break;
      }
      case "revision":
        value = await readRevision(db, actor, id);
        break;
      case "handoff":
        value = await readHandoff(db, actor, id);
        break;
      case "search":
        value = await searchMemory(db, actor, {
          ...page,
          query: q.get("q"),
          topic_id: q.get("topic") ?? undefined,
        });
        break;
      case "cursor":
        value = await revisionCursor(db, actor);
        break;
      default:
        throw new AppError(400, "알 수 없는 화면이에요.");
    }
    return Response.json(value, { headers });
  } catch (e) {
    return error(e);
  }
}
async function POST(req: Request) {
  try {
    if (req.headers.get("origin") !== new URL(req.url).origin)
      throw new AppError(403, "요청 출처를 확인할 수 없어요.");
    const actor = await webActor();
    // Enforce the real body size even when Content-Length is missing or inaccurate.
    const raw = await req.text();
    if (Buffer.byteLength(raw) > 500000)
      throw new AppError(413, "한 번에 남길 수 있는 크기를 넘었어요.");
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new AppError(400, "입력 형식을 확인해 주세요.");
    }
    const { action, ...value } = z.object({ action: z.string() }).passthrough().parse(input);
    if (action === "create_project")
      return Response.json(await createProject(database(), actor, value), {
        headers,
      });
    actor.projectId = projectIdSchema.parse(
      new URL(req.url).searchParams.get("project"),
    );
    if (action === 'submit_activity') return Response.json(await submitActivity(database(),actor,value),{headers});
    if (action === 'reconcile_activity') return Response.json(await reconcileActivity(database(),actor,value),{headers});
    if (action === 'approve_candidate') return Response.json(await approveCandidate(database(),actor,value),{headers});
    throw new AppError(400, "현재 정보의 정리는 ChatGPT에서 이어가요.");
  } catch (e) {
    return error(e);
  }
}
return { GET, POST };
}
