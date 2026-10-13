"use client";
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { CONNECTION_VERSION, MCP_COMMANDS, connectionGuidance, renderConnectionBlock, renderInstallPrompt, type ConnectionProject } from '@/lib/project-connection';

export function ConnectionSetup({ project }: { project: ConnectionProject }) {
  const [copied, setCopied] = useState(''), [error, setError] = useState('');
  let block: string, prompt: string;
  try { block = renderConnectionBlock(project); prompt = renderInstallPrompt(project); }
  catch { return <p role="alert" className="error">프로젝트 ID·운영 모드·저장소 정보를 확인해 주세요. 설정 내용을 만들지 못했어요.</p>; }
  const copy = async (label: string, value: string) => {
    setCopied(''); setError('');
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setError('자동 복사가 안 돼요. 아래 내용을 선택해서 복사해 주세요.'); }
  };
  return <div className="connection-setup">
    <p className="dialog-lead">{project.mode === 'connected' ? '개인 Codex에서 기억을 읽고 작업 결과를 이어 남겨요.' : '회사에서는 전달문으로 작업하고, 결과를 허용된 개인 환경으로 가져와요.'}</p>
    <p><strong>{project.mode === 'connected' ? 'Connected' : 'Handoff'}</strong> · 템플릿 {CONNECTION_VERSION}<br />프로젝트 {project.id}<br />저장소 {project.github_repository ?? '미등록'}</p>
    <p>{connectionGuidance(project)}</p>
    <section>
      <h3>Codex에 적용하기</h3>
      <p>프로젝트를 연 Codex에 설치 요청을 붙여 넣어요. 기존 지침을 조사한 뒤 Developlog 관리 블록만 추가하거나 갱신해요.</p>
      <p><a href="https://github.com/SpiritFlag/developlog/blob/main/web/ONBOARDING.md" target="_blank" rel="noopener noreferrer">공개 설치·복구 가이드</a>에서 설치기와 Codex 스킬 사용법을 확인할 수 있어요.</p>
      <button className="button primary" onClick={() => copy('install', prompt)}>{copied === 'install' ? <Check size={15} /> : <Copy size={15} />}{copied === 'install' ? '설치 요청을 복사했어요' : 'Codex 설치 요청 복사'}</button>
      <details><summary>설치 요청 직접 선택</summary><textarea aria-label="Codex 설치 요청" rows={8} readOnly value={prompt} /></details>
    </section>
    <section>
      <h3>AGENTS.md 내용</h3>
      <p>직접 편집할 때는 기존 지침을 보존하고 이 관리 블록 하나만 넣어요. 이미 설치했다면 같은 블록을 교체해요.</p>
      <textarea aria-label="AGENTS.md 연결 설정" readOnly value={block} rows={9} />
      <button className="button" onClick={() => copy('agents', block)}>{copied === 'agents' ? <Check size={15} /> : <Copy size={15} />}{copied === 'agents' ? '설정 내용을 복사했어요' : 'AGENTS.md 내용 복사'}</button>
    </section>
    {project.mode === 'connected' && <details>
      <summary>MCP 연결·인증 확인</summary>
      <ol className="steps">
        <li>Codex의 기존 Developlog 도구에서 list_projects를 호출해 위 프로젝트 ID와 저장소를 확인해요. 기존 플러그인 연결이 있으면 그대로 사용해요.</li>
        <li>연결이 없을 때만 개인 Codex의 설정 → MCP 서버에서 주소를 추가해요. CLI가 있다면 아래 명령을 사용할 수 있어요. 같은 이름이나 주소의 서버가 있으면 새로 추가하지 않아요.</li>
      </ol>
      <pre className="code-block">{MCP_COMMANDS}</pre>
      <p>기존 서버의 인증만 만료됐다면 그 서버 이름으로 로그인해요. Desktop에서는 기존 서버의 인증 버튼을 사용해요. 저장 후 새 채팅에서 도구 목록과 프로젝트 조회를 확인해요.</p>
      <p>인증 창은 사용자가 직접 완료해요. 토큰을 AGENTS.md나 프로젝트 파일에 복사하지 않아요.</p>
    </details>}
    <details><summary>재설치·제거·기록 점검</summary><p>재설치는 같은 프로젝트의 관리 블록만 갱신해요. 제거할 때는 developlog:begin부터 developlog:end까지의 관리 블록만 지워요. 하위 지침과 MCP 연결은 보존해요.</p><p>{project.mode === 'connected' ? '다음 작업에서 보관된 미처리 요청부터 점검해요. 성공 기록은 다시 보내지 않고 pending은 최신 맥락으로 재조정해요. Git 변경 흔적만으로 Activity를 만들지 않아요.' : '회사 환경에서는 개인 기록의 복구나 자동 제출을 하지 않아요. 전달받은 기준과 실제 확인 범위를 완료보고에 남겨요.'}</p></details>
    <p role="status" aria-live="polite">{copied ? '복사했어요.' : ''}</p>
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
