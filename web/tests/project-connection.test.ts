import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONNECTION_BEGIN, CONNECTION_END, CONNECTION_VERSION, connectionGuidance, renderConnectionBlock, renderInstallPrompt, type ConnectionProject } from '../lib/project-connection';
import { installConnection, updateAgents, inspectInstructions } from '../scripts/project-connection';
import { checkConnection } from '../scripts/connection-check';
import { RecoveryJournal } from '../scripts/activity-recovery';
import { submitActivitySchema } from '../lib/activity-model';

const exec = promisify(execFile);
const project: ConnectionProject = { id: 'synthetic-project', mode: 'connected', github_repository: 'example/synthetic' };
const handoff: ConnectionProject = { ...project, mode: 'handoff' };

test('public recovery refuses a missing or invalid explicit target without creating records', async () => {
  const f = await fixture(); try {
    assert.throws(() => new RecoveryJournal(join(f.root, '.local', 'developlog-activity'), ''));
    for (const args of [['scan'], ['--root', f.root, 'scan'], ['--project', project.id, 'scan']]) {
      await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'scripts/activity-recovery.ts', ...args], { timeout: 10000 }), error => {
        const failure = error as Error & { stdout: string; stderr: string };
        assert.equal(failure.stdout, ''); assert(failure.stderr.includes('preserve the selected request'));
        return true;
      });
    }
    assert(!(await readdir(f.root)).includes('.local'));
  } finally { await f.close(); }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'developlog-onboarding-'));
  const close = async () => {
    assert.equal(dirname(root), tmpdir()); assert(basename(root).startsWith('developlog-onboarding-'));
    await rm(root, { recursive: true, force: true });
  };
  return { root, close };
}
function request() {
  const operation_id = randomUUID();
  return { project_id: project.id, ...submitActivitySchema.parse({ operation_id, result_key: `codex:${operation_id}`, channel: 'connected', topic_ids: [],
    occurred_at: '2026-10-12T00:00:00.000Z', summary: 'Synthetic only', result: 'PRIVATE_SYNTHETIC_BODY', memory: { read_set: [], changes: [], reason: 'Synthetic' } }) };
}

test('mode-specific templates, identity validation and MCP states do not expose private settings', () => {
  const connected = renderConnectionBlock(project), transferred = renderConnectionBlock(handoff);
  assert(connected.includes(project.id)); assert(connected.includes(project.github_repository!));
  assert(connected.includes(CONNECTION_VERSION)); assert(connected.includes('submit_activity')); assert(connected.includes('codex mcp add'));
  assert(transferred.includes('개인 Developlog MCP를 설치·연결·로그인·호출하지 마'));
  assert(!transferred.includes('codex mcp')); assert(!transferred.includes('https://'));
  assert(!connected.includes('C:\\')); assert(!connected.includes('private-project-id'));
  assert(renderInstallPrompt(project).endsWith(connected));
  assert(connectionGuidance(project, 'connected').includes('재사용'));
  assert(connectionGuidance(project, 'missing').includes('없는지'));
  assert(connectionGuidance(project, 'unauthenticated').includes('인증만'));
  assert(connectionGuidance(project).includes('확인할 수 없어요'));
  assert.equal(connectionGuidance(handoff, 'missing'), connectionGuidance(handoff, 'connected'));
  assert.throws(() => renderConnectionBlock({ ...project, github_repository: 'owner/repo\nmalicious' }));
  assert.throws(() => renderConnectionBlock({ ...project, id: '../other' }));
});

test('install, repeat, upgrade, mode change and removal preserve exact existing bytes and child instructions', async () => {
  const f = await fixture(); try {
    const original = '\uFEFF# Existing instructions\r\nKeep $HOME and `code`. 한글\r\n';
    await writeFile(join(f.root, 'AGENTS.md'), original);
    await mkdir(join(f.root, 'src')); await writeFile(join(f.root, 'src', 'AGENTS.md'), 'child unchanged\r\n');
    await mkdir(join(f.root, '.codex')); await writeFile(join(f.root, '.codex', 'config.toml'), '# unrelated MCP sentinel');
    assert.equal((await installConnection(f.root, project)).changed, true);
    const installed = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
    assert.equal(installed.slice(installed.indexOf(CONNECTION_BEGIN), installed.indexOf(CONNECTION_END) + CONNECTION_END.length), renderConnectionBlock(project));
    assert.equal((await installConnection(f.root, project)).changed, false);
    await writeFile(join(f.root, 'AGENTS.md'), installed.replace(`"version":"${CONNECTION_VERSION}"`, '"version":"0.8.0"'));
    await installConnection(f.root, project);
    assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), installed);
    await installConnection(f.root, handoff);
    assert(!(await readFile(join(f.root, 'AGENTS.md'), 'utf8')).includes('codex mcp add'));
    await installConnection(f.root, handoff, true);
    assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), original);
    assert.equal((await installConnection(f.root, handoff, true)).changed, false);
    assert.equal(await readFile(join(f.root, 'src', 'AGENTS.md'), 'utf8'), 'child unchanged\r\n');
    assert.equal(await readFile(join(f.root, '.codex', 'config.toml'), 'utf8'), '# unrelated MCP sentinel');
  } finally { await f.close(); }
});

test('managed editing preserves suffix and rejects conflicts without edits', async () => {
  const original = 'prefix without newline';
  const installed = updateAgents(original, project) + 'suffix\r\n';
  assert.equal(updateAgents(installed, project, true), original + 'suffix\r\n');
  assert.throws(() => updateAgents(installed + renderConnectionBlock(project), project));
  assert.throws(() => updateAgents(CONNECTION_BEGIN, project));
  assert.throws(() => updateAgents(installed, { ...project, id: 'other' }));
  assert.throws(() => updateAgents('# Developlog Connected 기존 연결', project));
  const f = await fixture(); try {
    await writeFile(join(f.root, 'AGENTS.md'), 'unchanged');
    await writeFile(join(f.root, 'AGENTS.override.md'), 'override unchanged');
    assert.equal((await inspectInstructions(f.root)).has_override, true);
    await assert.rejects(installConnection(f.root, project), /override/);
    assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), 'unchanged');
    assert.equal(await readFile(join(f.root, 'AGENTS.override.md'), 'utf8'), 'override unchanged');
  } finally { await f.close(); }
});

test('generic CLI targets a synthetic project and renders the same template in a separate process', { timeout: 15000 }, async () => {
  const f = await fixture(); try {
    const config = join(f.root, 'project.json'); await writeFile(config, JSON.stringify(project));
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/project-connection.ts', 'render', f.root, config], { timeout: 10000 });
    assert.equal(result.stdout, renderConnectionBlock(project));
    await exec(process.execPath, ['--import', 'tsx', 'scripts/project-connection.ts', 'install', f.root, config], { timeout: 10000 });
    assert((await readFile(join(f.root, 'AGENTS.md'), 'utf8')).includes(result.stdout));
  } finally { await f.close(); }
});

test('startup imports old requests, skips stored success, preserves unknown/pending and never sends', async () => {
  const f = await fixture(); try {
    const dir = join(f.root, '.local', 'developlog-activity'); await mkdir(dir, { recursive: true });
    const old = request(), successful = request(), unknown = request(), pending = request();
    const j = new RecoveryJournal(dir, project.id);
    await writeFile(join(dir, `${old.operation_id}.request.json`), JSON.stringify(old));
    await j.prepare(successful); await j.recordReceipt(successful.operation_id, { activity_id: randomUUID(), memory_status: 'applied', memory_version: 1 });
    await j.prepare(unknown); await j.beginAttempt(unknown.operation_id); await j.noteFailure(unknown.operation_id, 'unknown');
    await j.prepare(pending); await j.recordReceipt(pending.operation_id, { activity_id: randomUUID(), memory_status: 'pending', memory_version: 1 });
    const foreign = { ...request(), project_id: 'different-project' }; await writeFile(join(dir, `${foreign.operation_id}.request.json`), JSON.stringify(foreign));
    const before = await readFile(join(dir, `${unknown.operation_id}.request.json`), 'utf8');
    const scan = await j.scan();
    assert.equal(scan.items.length, 3); assert.equal(scan.truncated, false);
    assert.equal(scan.last_recorded_at, successful.occurred_at);
    assert.equal(scan.items.find(x => x.operation_id === old.operation_id)?.status, 'unknown');
    assert.equal(scan.items.find(x => x.operation_id === pending.operation_id)?.action, 'read_activity');
    assert.equal(scan.items.find(x => x.operation_id === unknown.operation_id)?.action, 'submit_activity');
    assert.equal((await j.inspect(unknown.operation_id)).attempts, 1);
    assert.equal(await readFile(join(dir, `${unknown.operation_id}.request.json`), 'utf8'), before);
    assert(!JSON.stringify(scan).includes('PRIVATE_SYNTHETIC_BODY'));
    const cli = await exec(process.execPath, ['--import', 'tsx', 'scripts/activity-recovery.ts', '--root', f.root, '--project', project.id, 'scan'], { timeout: 10000 });
    assert.equal(JSON.parse(cli.stdout).items.length, 3); assert(!cli.stdout.includes('PRIVATE_SYNTHETIC_BODY'));
    assert.equal((await j.scan(1)).truncated, true);
    const first = await j.scan(1);
    const rest = await j.scan(100, first.next_cursor!);
    assert.equal(first.items.length + rest.items.length, 3);
    assert.equal(rest.next_cursor, null);
    // Unknown original remains byte-for-byte reusable by the existing sender flow.
    assert.deepEqual(await j.beginAttempt(unknown.operation_id), unknown);
  } finally { await f.close(); }
});

test('startup flags orphan/tampered files and handoff never touches personal journal', async () => {
  const f = await fixture(); try {
    const dir = join(f.root, '.local', 'developlog-activity');
    const j = new RecoveryJournal(dir, project.id), r = request(); await j.prepare(r);
    await writeFile(join(dir, `${r.operation_id}.request.json`), '{}');
    const orphan = randomUUID(); await writeFile(join(dir, `${orphan}.state.json`), '{}');
    const scan = await j.scan();
    assert.equal(scan.items.find(x => x.operation_id === orphan)?.action, 'inspect_privately');
    // Missing/invalid identity must be surfaced, not treated as an unrelated valid project.
    assert.equal(scan.items.find(x => x.operation_id === r.operation_id)?.action, 'inspect_privately');
    await writeFile(join(dir, `${r.operation_id}.request.json`), JSON.stringify({ ...r, project_id: 'tampered-identity' }));
    assert.equal((await j.scan()).items.find(x => x.operation_id === r.operation_id)?.action, 'inspect_privately');
    const files = await readdir(dir);
    assert.deepEqual(await checkConnection(f.root, handoff), { mode: 'handoff', action: 'handoff_only' });
    assert.deepEqual(await readdir(dir), files);
  } finally { await f.close(); }
});

test('bounded Git changes are hints only and do not manufacture a journal or Activity', async () => {
  const f = await fixture(); try {
    await exec('git', ['init', f.root], { timeout: 5000 });
    await writeFile(join(f.root, 'changed.txt'), 'PRIVATE_SYNTHETIC_BODY');
    const result = await checkConnection(f.root, project);
    assert('changes' in result); assert.equal(result.changes?.available, true);
    assert.equal(result.changes?.tracked_or_untracked_entries, 1);
    assert.equal(result.recovery?.items.length, 0);
    assert(!JSON.stringify(result).includes('changed.txt')); assert(!JSON.stringify(result).includes('PRIVATE_SYNTHETIC_BODY'));
    await assert.rejects(readFile(join(f.root, '.local', 'developlog-activity', 'state.json')));
    assert(!(await readdir(f.root)).includes('.local'));
  } finally { await f.close(); }
});
