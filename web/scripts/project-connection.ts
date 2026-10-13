/** Local AGENTS editor. Never reads credentials or writes MCP configuration. */
import { lstat, readFile, readdir, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTION_BEGIN, CONNECTION_END, renderConnectionBlock, validateConnectionProject, type ConnectionProject } from '../lib/project-connection';

export function managedRange(text: string) {
  const begins = text.split(CONNECTION_BEGIN).length - 1, ends = text.split(CONNECTION_END).length - 1;
  if (!begins && !ends) return null;
  if (begins !== 1 || ends !== 1) throw new Error('관리 블록 마커가 중복되거나 손상됐어요. 원문을 보존했어요.');
  const start = text.indexOf(CONNECTION_BEGIN), end = text.indexOf(CONNECTION_END) + CONNECTION_END.length;
  if (end <= start) throw new Error('관리 블록 순서를 확인해 주세요.');
  const body = text.slice(start, end);
  const match = body.match(/<!-- developlog:metadata (.+) -->/);
  if (!match) throw new Error('관리 블록의 프로젝트 메타데이터가 없어요.');
  const metadata = JSON.parse(match[1]);
  const project = validateConnectionProject(metadata);
  if (typeof metadata.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(metadata.version)) throw new Error('설치 버전을 확인해 주세요.');
  // The installer owns only its framed block, including its own separator.
  const framed = text.slice(Math.max(0, start - 2), start) === '\n\n' && text[end] === '\n';
  return { start: framed ? start - 2 : start, end: framed ? end + 1 : end, metadata: { version: metadata.version, ...project } };
}

export function updateAgents(text: string, project: ConnectionProject, remove = false) {
  validateConnectionProject(project);
  const range = managedRange(text);
  if (range && (range.metadata.id !== project.id || range.metadata.github_repository !== project.github_repository)) {
    throw new Error('다른 프로젝트의 관리 블록이에요. 기존 연결을 보존했어요.');
  }
  if (remove) return range ? text.slice(0, range.start) + text.slice(range.end) : text;
  const outside = range ? text.slice(0, range.start) + text.slice(range.end) : text;
  if (/Developlog Connected|Developlog 프로젝트 연결|Developlog Handoff/i.test(outside)) {
    throw new Error('관리 블록 밖에 기존 디로그 연결 지침이 있어요. 중복 설치하지 않고 보존했어요.');
  }
  const block = `\n\n${renderConnectionBlock(project)}\n`;
  return range ? text.slice(0, range.start) + block + text.slice(range.end) : text + block;
}

async function regularText(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('지침 경로가 일반 파일이 아니에요.');
    return await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

export async function inspectInstructions(root: string) {
  const directory = await realpath(root);
  if (resolve(root).toLowerCase() !== directory.toLowerCase()) throw new Error('별칭 경로 대신 실제 프로젝트 경로를 선택해 주세요.');
  const files: string[] = [], queue = [''];
  let visited = 0;
  while (queue.length && visited < 150) {
    const relative = queue.shift()!; visited++;
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      if (item.isFile() && ['AGENTS.md', 'AGENTS.override.md'].includes(item.name)) files.push(join(relative, item.name));
      if (item.isDirectory() && !item.name.startsWith('.') && !['node_modules', 'dist', 'build', 'vendor'].includes(item.name)) queue.push(join(relative, item.name));
    }
  }
  const agents = await regularText(join(directory, 'AGENTS.md'));
  const override = await regularText(join(directory, 'AGENTS.override.md'));
  return { root: directory, files, truncated: queue.length > 0, has_override: !!override.trim(), agents,
    installed: managedRange(agents)?.metadata ?? null };
}

export async function installConnection(root: string, project: ConnectionProject, remove = false) {
  const inspected = await inspectInstructions(root);
  if (inspected.has_override && !remove) throw new Error('AGENTS.override.md가 루트 지침을 가려요. 기존 파일을 보존하고 적용 위치를 먼저 정해 주세요.');
  const next = updateAgents(inspected.agents, project, remove);
  if (Buffer.byteLength(next) > 30000 && !remove) throw new Error('루트 지침이 기본 32 KiB 한도에 가까워요. 기존 지침을 보존했어요.');
  const file = join(inspected.root, 'AGENTS.md');
  if (next !== inspected.agents) {
    // Reject a change made after inspection instead of overwriting it.
    if (await regularText(file) !== inspected.agents) throw new Error('조사 후 지침이 바뀌었어요. 다시 확인해 주세요.');
    const temp = join(inspected.root, `.developlog-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, next, { flag: 'wx' });
      if (await regularText(file) !== inspected.agents) throw new Error('조사 후 지침이 바뀌었어요. 다시 확인해 주세요.');
      await rename(temp, file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  return { changed: next !== inspected.agents, project_id: project.id, mode: project.mode,
    file, instructions: inspected.files, truncated: inspected.truncated };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, projectFile] = process.argv.slice(2);
  try {
    if (!root) throw new Error('대상 프로젝트 경로가 필요해요.');
    if (command === 'inspect') {
      const { agents: _private, ...metadata } = await inspectInstructions(root);
      process.stdout.write(JSON.stringify(metadata) + '\n');
    } else {
      const project = validateConnectionProject(JSON.parse(await readFile(projectFile, 'utf8')));
      if (command === 'render') process.stdout.write(renderConnectionBlock(project));
      else if (command === 'install' || command === 'remove') process.stdout.write(JSON.stringify(await installConnection(root, project, command === 'remove')) + '\n');
      else throw new Error('inspect/render/install/remove 중 하나를 선택해 주세요.');
    }
  } catch { process.stderr.write('연결 설치를 완료하지 못했어요. 원 지침을 보존하고 대상·메타데이터·관리 블록 충돌을 확인해 주세요.\n'); process.exitCode = 1; }
}
