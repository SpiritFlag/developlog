import type { Recommendation } from "../lib/work-recommendation";

export function HandoffRecommendation({ recommendation }: {
  recommendation?: Recommendation | null;
}) {
  return (
    <div className="condition handoff-recommendation">
      <strong>추천 실행 설정</strong>
      {recommendation ? (
        <>
          <p className="handoff-settings"><strong>{recommendation.model} · {recommendation.reasoning}</strong></p>
          <p>{recommendation.reason}</p>
          <small>Work 작성 시 추천한 설정이에요. Codex에서 직접 선택해 주세요.</small>
        </>
      ) : (
        <p className="quiet">이 Work에는 추천 설정이 아직 없어요. ChatGPT에서 작업을 정리할 때 모델과 추론 강도도 함께 추천받아 주세요. 전달문은 그대로 복사할 수 있어요.</p>
      )}
    </div>
  );
}
