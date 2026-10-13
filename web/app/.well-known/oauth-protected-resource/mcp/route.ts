import {
  protectedResourceHandlerClerk,
  metadataCorsOptionsRequestHandler,
} from "@clerk/mcp-tools/next";
export const GET = protectedResourceHandlerClerk({
  resource: "https://developlog.spiritflag.work/mcp",
  scopes_supported: ["openid", "profile", "email"],
});
export const OPTIONS = metadataCorsOptionsRequestHandler();
