import { z } from "zod";

export const recommendationSchema = z.object({
  model: z.enum(["Sol", "Astra"]),
  reasoning: z.enum(["Light", "Medium", "High", "Extra High", "Ultra"]),
  reason: z.string().trim().min(1).max(600),
}).strict();
export type Recommendation = z.infer<typeof recommendationSchema>;

// Work recommendations are authored by the connected assistant, not generated
// by a second LLM in the web app. Invalid/missing sections must not break text.
export function readWorkRecommendation(body: string): Recommendation | null {
  const sections = body.replace(/\r\n/g, "\n").split(/^##[ \t]+/m);
  const matches = sections.slice(1).filter((section) =>
    /^추천 실행 설정[ \t]*\n/.test(section),
  );
  // Ambiguous duplicate sections are not a reliable recommendation.
  if (matches.length !== 1) return null;
  const lines = matches[0].split("\n").slice(1);
  while (lines.length && !lines[0].trim()) lines.shift();
  const settings = lines.shift()?.trim().split(/[ \t]*·[ \t]*/);
  if (settings?.length !== 2) return null;
  const parsed = recommendationSchema.safeParse({
    model: settings[0],
    reasoning: settings[1],
    reason: lines.join("\n").trim(),
  });
  return parsed.success ? parsed.data : null;
}
