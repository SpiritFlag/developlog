import { withMcpAuth } from "mcp-handler";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { auth } from "@clerk/nextjs/server";
import { createProjectMcp } from "@/lib/mcp-server";
export const maxDuration = 60;
const handler = withMcpAuth(
  createProjectMcp(),
  async (_, token) =>
    verifyClerkToken(await auth({ acceptsToken: "oauth_token" }), token),
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
    resourceUrl: "https://developlog.spiritflag.work",
  },
);
export { handler as POST, handler as GET };
