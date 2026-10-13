# 프로젝트 연결 온보딩 · 1.0.1

웹 프로젝트 화면의 **연결 설정**에서 현재 프로젝트의 ID·mode·저장소를 확인하고 **Codex 설치 요청 복사**를 대상 프로젝트의 Codex에 붙여 넣어. **AGENTS.md 내용 복사**는 수동 편집용이야. 웹과 설치기는 `lib/project-connection.ts`의 같은 1.0.1 렌더러를 사용해.

## 공개 파일로 설치하기

웹에서 복사한 설치 요청에는 완전한 관리 블록이 들어 있어. 대상 프로젝트의 기존 지침을 조사하고 그 블록만 적용할 수 있어. 별도의 스킬 다운로드나 이 저장소의 비공개 파일은 필요 없어. Connected는 기존 MCP로 메타데이터를 확인하고, Handoff는 전달문만 사용해. 웹은 로컬 MCP 인증 성공 여부를 알 수 없어.

반복 가능한 설치·갱신·제거와 복구 도우미를 사용하려면 공개 소스 전체를 체크아웃해. Node.js 24와 의존성이 필요해. 대상 프로젝트는 Node 프로젝트일 필요가 없어.

```sh
git clone https://github.com/SpiritFlag/developlog.git
cd developlog/web
npm ci
```

`.agents/skills/developlog-connect/SKILL.md`를 그 체크아웃의 경로로 직접 참조할 수 있어. 스킬 폴더만 복사하면 상대 경로가 깨져. 다른 프로젝트에 스킬이 자동 설치되지는 않아.

웹에서 확인한 세 필드를 비공개 프로젝트 JSON 파일에 저장해. 아래 값은 합성 예시야. 실제 프로젝트의 값을 사용해.

```json
{"id":"synthetic-project","mode":"connected","github_repository":"example/synthetic"}
```

공개 체크아웃의 `web`에서 실행해. 경로에 공백이 있으면 따옴표로 감싸.

```text
node --import tsx scripts/project-connection.ts inspect <대상 루트>
node --import tsx scripts/project-connection.ts render <대상 루트> <프로젝트 JSON 파일>
node --import tsx scripts/project-connection.ts install <대상 루트> <프로젝트 JSON 파일>
node --import tsx scripts/connection-check.ts <대상 루트> <프로젝트 JSON 파일>
node --import tsx scripts/project-connection.ts remove <대상 루트> <프로젝트 JSON 파일>
```

설치기는 기존 AGENTS.md의 관리 블록 하나만 바꾸고 하위 지침·MCP 설정을 보존해. 같은 내용의 재설치는 파일을 쓰지 않아. 다른 프로젝트·중복/손상 마커·비관리 연결 지침·루트 AGENTS.override.md·크기 한도 충돌이면 파일을 보존하고 멈춰. 하위 조사 한도는 150개 디렉터리야.

## Connected와 Handoff

| 모드 | 시작 | 종료 | 복구 |
| --- | --- | --- | --- |
| 개인 Connected | 기존 MCP로 고정 ID·저장소·mode와 관련 기억 확인 | 실제 변경·남길 검증을 기존 submit_activity로 기록 | 비공개 원 요청·receipt와 기존 MCP 사용 |
| 회사 Handoff | 제공된 전달문과 로컬 지침 사용 | 허용된 최소 완료보고 작성 | 개인 환경으로 가져온 승인된 결과만 처리 |

Handoff에서는 개인 MCP 조회·설치·로그인·자동 제출과 개인 기록 디렉터리 생성을 하지 않아. Connected의 신규 OAuth는 사용자가 직접 완료해.

## 공개 복구 도우미

`scripts/activity-recovery.ts`는 네트워크·인증·DB 접속 기능 없는 로컬 상태 도우미야. 공개본에는 개인 프로젝트 기본값이 없어. 생성자는 프로젝트 ID를 받고, CLI는 **모든 명령에 --root와 --project가 필요해**.

```text
node --import tsx scripts/activity-recovery.ts --root <대상 루트> --project <ID> scan
node --import tsx scripts/activity-recovery.ts --root <대상 루트> --project <ID> prepare <원 요청 JSON 파일>
node --import tsx scripts/activity-recovery.ts --root <대상 루트> --project <ID> status <operation_id>
node --import tsx scripts/activity-recovery.ts --root <대상 루트> --project <ID> begin <operation_id>
node --import tsx scripts/activity-recovery.ts --root <대상 루트> --project <ID> receipt <operation_id> <응답 JSON 파일>
```

begin이 허용한 현재 시도만 기존 MCP에 보관 요청 그대로 전송해. unknown은 동일 ID·시각·본문의 정확 재시도야. pending은 이미 저장됐으므로 read_activity와 최신 기억을 확인하고 reconcile_activity로 이어가. `reconcile`, `observed`, `failure`, `resume`도 같은 명시적 대상 옵션을 사용해. 한 회차 최대 두 전송이며 승인/인증/입력 거절은 중단해. 성공은 다시 보내지 않아.

보관 경로는 `<대상 루트>/.local/developlog-activity/`야. 기록 전에 Git·배포 제외를 확인해. 확인할 수 없거나 사용자 파일 제한이 있으면 파일을 쓰지 않고 현재 실행 기록만 보존해. 회사 원문·인증정보·무관한 데이터는 넣지 마. 도우미는 요청 본문을 출력하지 않지만 OS 암호화나 다른 도구의 로그를 제어하지는 않아.

check/scan은 최대 100개 메타데이터를 확인해. truncated/next_cursor가 있으면 필요한 범위만 scan의 다음 커서로 이어 읽어. Git 변경/커밋 개수는 기록 누락의 증거가 아니야. 보관된 요청이나 실제 실행 근거 없이 Activity를 만들지 마.

## 검증과 한계

공개 테스트는 합성 임시 폴더·인메모리 PGlite·실제 UI 컴포넌트에 합성 인증/API 경계를 사용해. `npm test`, `npm run typecheck`, `npm run build`로 확인할 수 있어. 브라우저 테스트에는 Windows Edge 또는 Playwright Chromium이 필요해. Chromium이 없다면 `npx playwright install chromium`으로 준비해.

1.0.1 로컬 실사용에서는 설치한 별도 Desktop 일반 채팅의 시작 조회→관련 Topic 선택→문서 수정→자동 종료 제출→운영 Activity 저장을 관찰했어. 그 채팅은 중립 한 줄을 상속한 같은 폴더 fork였어. 무상속 UI 새 채팅·신규 OAuth 발급/refresh·실제 운영 장애·미래 실행 강제 호출은 별도 확인 범위야. 자동 종료 훅·상주 큐·주기적 감시 기능은 없어.
