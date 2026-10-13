/** Startup inspection: local metadata only. Recovery remains in RecoveryJournal + the existing MCP. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryJournal } from './activity-recovery';
import { validateConnectionProject, type ConnectionProject } from '../lib/project-connection';
const exec = promisify(execFile);

export async function checkConnection(root: string, input: ConnectionProject) {
  const project = validateConnectionProject(input);
  if (project.mode === 'handoff') return { mode: project.mode, action: 'handoff_only' };
  const journal = new RecoveryJournal(join(resolve(root), '.local', 'developlog-activity'), project.id);
  const recovery = await journal.scan();
  let changes: { available: boolean; tracked_or_untracked_entries?: number; commits_since_record?: number; commits_capped?: boolean; reason?: string };
  try {
    const options = { cwd: resolve(root), timeout: 5000, maxBuffer: 65536, windowsHide: true };
    const status = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], options);
    const entries = status.stdout.split('\0').filter(Boolean);
    let count = 0;
    for (let i = 0; i < entries.length; i++) { count++; if (/^[RC]|^.[RC]/.test(entries[i])) i++; }
    changes = { available: true, tracked_or_untracked_entries: count };
    if (recovery.last_recorded_at) {
      const log = await exec('git', ['log', `--since=${recovery.last_recorded_at}`, '--max-count=21', '--format=%H'], options);
      const commits = log.stdout.trim().split('\n').filter(Boolean).length;
      changes.commits_since_record = Math.min(commits, 20); changes.commits_capped = commits > 20;
    }
  } catch { changes = { available: false, reason: 'Git metadata unavailable or exceeds the bounded inspection.' }; }
  return { mode: project.mode, project_id: project.id, recovery, changes,
    interpretation: '변경 흔적은 기록 누락의 증거가 아니야. 보관 요청 또는 확인 가능한 실행 근거 없이 Activity를 만들지 마.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, projectFile] = process.argv.slice(2);
    const project = JSON.parse(await readFile(projectFile, 'utf8'));
    process.stdout.write(JSON.stringify(await checkConnection(root, project)) + '\n');
  } catch { process.stderr.write('시작 점검을 완료하지 못했어요. 기존 기록을 보존하고 필요한 범위만 확인해 주세요.\n'); process.exitCode = 1; }
}
