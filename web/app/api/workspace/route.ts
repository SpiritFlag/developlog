import { database } from "@/lib/db";
import { webActor } from "@/lib/auth";
import { createWorkspaceApi } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";
export const { GET, POST } = createWorkspaceApi(database, webActor);
