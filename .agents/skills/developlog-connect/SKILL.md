---
name: developlog-connect
description: Developlog 프로젝트를 현재 작업 폴더에 연결하거나 연결 지침을 갱신·제거해. "디로그 연결해줘" 요청에 기존 설정을 조사하고 Connected/Handoff에 맞는 AGENTS.md 관리 블록을 설치해.
---

# Developlog 연결

공개 온보딩 버전은 1.0.1이야. `web/ONBOARDING.md`가 공개 설치·복구 안내야. 복구 도우미는 개인 기본값이 없으므로 모든 CLI 호출에 `--root <대상 루트> --project <ID>`를 명시해.

이 스킬은 Developlog 소스 체크아웃에 포함돼 있어. 스킬 폴더에서 `../../../`가 소스 루트야. 스킬 폴더만 다른 위치로 복사하지 마. 다른 프로젝트에서는 이 소스 체크아웃의 스킬을 명시적으로 참조하거나 웹의 **연결 설정 → Codex 설치 요청 복사**를 사용해. 공식 Codex 로컬 스킬과 AGENTS.md 지침 방식이며 전용 Desktop 설치 API는 사용하지 않아.

## 대상 조사

1. 사용자가 연결하려는 실제 프로젝트 루트와 기존 AGENTS.md·AGENTS.override.md·적용되는 하위 지침을 조사해. 아래 inspect는 경로 목록만 반환하고 최대 150개 디렉터리만 확인해. truncated이면 실제 작업할 하위 경로만 추가 확인해. 링크 경로와 손상된/중복 관리 블록, 다른 프로젝트 연결을 덮어쓰지 마.
2. 사용자 요청 또는 웹 설치 요청에 있는 프로젝트 ID·mode·github_repository를 사용해. 이름/폴더명만으로 프로젝트를 고르지 마. Git remote가 있다면 자격증명을 출력하지 않는 방식으로 owner/repo만 비교해. 불일치이면 설치를 멈추고 해당 차이를 알려줘.
3. **회사 Handoff이면 개인 MCP를 조회·추가·로그인하지 마.** 전달된 메타데이터만 사용해. 개인 Connected는 기존 Developlog 도구를 먼저 찾아 list_projects(limit≤30)를 호출하고 고정 ID/저장소/mode를 확인해. 이름이 달라도 같은 기존 연결을 재사용해. 설정 존재는 인증 성공 증거가 아니야.
4. 도구가 없으면 Desktop 설정 → MCP 서버 또는 `codex mcp list`로 기존 연결을 확인해. 플러그인 연결도 중복 추가하지 마. 신규 연결은 개인 Connected이고 사용자의 연결 요청 범위일 때만 안내해. 실제 명령/주소는 `web/lib/project-connection.ts`의 MCP_COMMANDS를 사용해. 이름이 점유됐거나 주소가 다르면 그 설정을 덮어쓰지 마. OAuth는 사용자가 직접 완료해. 토큰/환경변수/다른 서버 설정 본문은 읽거나 복사하지 마.

## 적용

소스 체크아웃의 `web`에서 실행해. Node와 이 체크아웃의 설치된 의존성이 필요해. 대상 프로젝트에 의존성이나 서버를 설치하지 않아.

```text
node --import tsx scripts/project-connection.ts inspect <대상 루트>
node --import tsx scripts/project-connection.ts render <대상 루트> <프로젝트 JSON 파일>
node --import tsx scripts/project-connection.ts install <대상 루트> <프로젝트 JSON 파일>
```

프로젝트 JSON은 `{ "id": "명시적 ID", "mode": "connected 또는 handoff", "github_repository": "owner/repo 또는 null" }` 세 필드야. 조사해서 확인한 값을 임시 파일에 저장해. 개인 절대 경로·토큰을 생성 AGENTS에 넣지 마. 예시 문자열 자체를 실제 값으로 설치하지 마.

웹과 설치기는 `web/lib/project-connection.ts` 하나를 사용해. 블록 밖의 기존 디로그 지침·루트 override가 발견되면 자동 변환하지 말고 충돌 범위만 설명해. 파일은 그대로 보존해. 일반 설치·갱신은 사용자 요청이 이미 승인한 작업이므로 다시 확인받지 않아. 설치기는 하위 지침을 변경하지 않아.

Connected에서 실제 기록 파일을 쓰기 전 `.local/developlog-activity/`가 Git과 배포에서 제외되는지 확인해. 누락된 경우 해당 경로만 `.gitignore`와 해당 프로젝트의 배포 제외 파일에 추가해. 기존 규칙/설정을 보존해. 배포 제외 방법을 확인할 수 없거나 파일 변경 제한이 있으면 로컬 파일 보관을 보장하지 말고 실행 기록 보존의 한계를 알려줘. Handoff에는 개인 기록 디렉터리를 만들지 마.

## 다음 작업 점검과 복구

```text
node --import tsx scripts/connection-check.ts <대상 루트> <프로젝트 JSON 파일>
node --import tsx scripts/activity-recovery.ts --root <대상 루트> --project <프로젝트 ID> status <operation_id>
```

check는 현재 프로젝트의 보관 요청 최대 100개와 제한 Git 메타데이터만 검사해. 미처리 목록은 전송 승인이 아니야. 작업과 관련된 ID만 선택해 기존 RecoveryJournal의 prepare/status/begin/receipt/reconcile/observed/failure/resume을 사용하고 **기존 MCP로** 정확한 원 요청만 전송해. 도우미는 네트워크/인증 기능이 없어. blocked는 정상 연결 복구 확인 또는 명시적 복구 요청 후 해당 ID만 resume해. unknown은 정확 재시도, pending은 read_activity 후 최신 맥락 reconcile이야. 최대 두 시도 후 중단해. 전체 Source/요청/오류 본문을 로그로 출력하지 마.

마지막 기록 이후의 변경 개수·커밋 시각은 누락의 증거가 아니야. 보관 요청이나 확인 가능한 실제 실행 근거가 없으면 Activity를 만들어내지 마. truncated/불명확 상태를 완료로 보고하지 마.

truncated이면 필요한 범위만 `activity-recovery.ts --root <대상 루트> --project <ID> scan <next_cursor>`로 이어 읽어. 범위별 last_recorded_at을 전체 최신 기록이라고 단정하지 마.

## 제거와 보고

`node --import tsx scripts/project-connection.ts remove <대상 루트> <프로젝트 JSON 파일>`은 같은 프로젝트의 관리 블록만 제거해. MCP 연결·하위 지침·과거 기록은 삭제하지 않아.

설치 버전·대상 ID·mode·변경 파일·인증 확인 여부·남은 충돌을 짧게 보고해. 새 Codex 채팅에서의 실제 시작 조회/종료 제출은 관찰했을 때만 검증됐다고 말해. 스킬 발견이나 지침 테스트만으로 실제 새 채팅 검증을 대신하지 마.
