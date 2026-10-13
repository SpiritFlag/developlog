import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoffRecommendation } from "../components/handoff-recommendation";
import { recommendationSchema, readWorkRecommendation } from "../lib/work-recommendation";

const reason = "기존 구조를 추적하고 제한된 변경의 회귀를 검증하는 작업이에요.";
const body = (settings: string, explanation = reason) =>
  `기존 작업 내용\n\n## 추천 실행 설정\n\n${settings}\n\n${explanation}\n\n## 제약\n\n기존 API 유지`;

test("recommendation schema accepts only the requested models and reasoning levels", () => {
  for (const model of ["Sol", "Astra"]) {
    for (const reasoning of ["Light", "Medium", "High", "Extra High", "Ultra"]) {
      assert.deepEqual(readWorkRecommendation(body(`${model} · ${reasoning}`)), { model, reasoning, reason });
    }
  }
  for (const invalid of [
    { model: "Luna", reasoning: "Medium", reason },
    { model: "Sol", reasoning: "Max", reason },
    { model: "sol", reasoning: "medium", reason },
    { model: "Sol", reasoning: "Medium", reason: " " },
    { model: "Sol", reasoning: "Medium", reason: "x".repeat(601) },
  ]) {
    assert.equal(recommendationSchema.safeParse(invalid).success, false);
    assert.equal(readWorkRecommendation(body(`${invalid.model} · ${invalid.reasoning}`, invalid.reason)), null);
  }
});

test("missing, malformed and ambiguous recommendations leave the Work usable", () => {
  for (const input of ["기존 본문", body("Luna · Medium"), body("Sol · High · Ultra"), body("Sol · Medium") + "\n\n## 추천 실행 설정\nAstra · Ultra\n이유"]) {
    assert.equal(readWorkRecommendation(input), null);
  }
  assert.deepEqual(readWorkRecommendation(body("Sol · Medium").replace(/\n/g, "\r\n")), { model: "Sol", reasoning: "Medium", reason });
});

test("handoff UI shows settings and reason, with a compatible legacy empty state", () => {
  const html = renderToStaticMarkup(createElement(HandoffRecommendation, {
    recommendation: recommendationSchema.parse({ model: "Sol", reasoning: "Medium", reason }),
  }));
  assert.ok(html.includes("추천 실행 설정"));
  assert.ok(html.includes("Sol · Medium"));
  assert.ok(html.includes(reason));
  for (const recommendation of [null, undefined]) {
    const legacy = renderToStaticMarkup(createElement(HandoffRecommendation, { recommendation }));
    assert.ok(legacy.includes("추천 설정이 아직 없어요"));
    assert.ok(legacy.includes("전달문은 그대로 복사할 수 있어요"));
  }
});
