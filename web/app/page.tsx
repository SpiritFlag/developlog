import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import Workspace from "@/components/workspace";
import ProjectLibrary from "@/components/project-library";
import { database } from "@/lib/db";
import { listProjects } from "@/lib/service";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[]; cursor?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  if (
    !process.env.DEVELOPLOG_OWNER_ID ||
    userId !== process.env.DEVELOPLOG_OWNER_ID
  )
    return (
      <main className="auth-page">
        <section>
          <h1>개인 작업 공간이에요.</h1>
          <p>프로젝트 소유자 계정으로 로그인해 주세요.</p>
          <UserButton />
        </section>
      </main>
    );
  const query = await searchParams;
  if (typeof query.project === "string" && query.project.trim())
    return <Workspace key={query.project} projectId={query.project} />;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  const projects = await listProjects(
    database(),
    { id: userId, kind: "human" },
    { cursor, limit: 12 },
  );
  return <ProjectLibrary projects={projects} hasPrevious={!!cursor} />;
}
