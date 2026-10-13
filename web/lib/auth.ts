import { auth } from "@clerk/nextjs/server";
import { AppError, type Actor } from "./model";
export function owner(
  id: string | null | undefined,
  kind: Actor["kind"],
): Actor {
  if (!id) throw new AppError(401, "로그인이 필요해요.");
  if (
    !process.env.DEVELOPLOG_OWNER_ID ||
    id !== process.env.DEVELOPLOG_OWNER_ID
  )
    throw new AppError(403, "프로젝트 소유자만 접근할 수 있어요.");
  return { id, kind };
}
export async function webActor() {
  const { userId } = await auth();
  return owner(userId, "human");
}
