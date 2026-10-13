/** Local journal only. No network, credentials, database, scheduler or payload logging. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitActivitySchema, reconcileActivitySchema } from '../lib/activity-model';

type Request = Record<string, unknown> & { project_id: string; operation_id: string };
type State = {
  schema_version: 1; kind: 'submit' | 'reconcile'; operation_id: string; project_id: string;
  request_sha256: string; status: 'prepared' | 'not_sent' | 'unknown' | 'pending' | 'applied' | 'superseded' | 'blocked';
  attempts: number; cycle_attempts: number; needs_action?: boolean; previous_status?: State['status']; parent_operation_id?: string;
  activity_id?: string; memory_version?: number; reason?: 'before_send' | 'unknown' | 'rejected' | 'auth';
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
const safeError = () => new Error('Local recovery record unavailable or inconsistent; preserve files and inspect privately.');
const parse = (text: string) => { try { return JSON.parse(text); } catch { throw safeError(); } };

export class RecoveryJournal {
  readonly directory: string;
  constructor(directory: string, readonly projectId: string) {
    this.directory = resolve(directory);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(projectId)) throw safeError();
    if (basename(this.directory) !== 'developlog-activity' || basename(dirname(this.directory)) !== '.local') throw safeError();
  }
  private path(id: string, suffix: string) {
    if (!uuid.test(id)) throw safeError();
    return join(this.directory, `${id}.${suffix}.json`);
  }
  private async directoryReady() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const actual = await realpath(this.directory);
    if ((process.platform === 'win32' ? actual.toLowerCase() : actual) !==
        (process.platform === 'win32' ? this.directory.toLowerCase() : this.directory)) throw safeError();
  }
  private async read(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw safeError();
    return readFile(path, 'utf8');
  }
  private async immutable(path: string, value: unknown) {
    const text = JSON.stringify(value, null, 2) + '\n';
    let created = false;
    try {
      const fd = await open(path, 'wx', 0o600);
      try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw safeError();
      if (canonical(parse(await this.read(path))) !== canonical(value)) throw safeError();
    }
    return {text:await this.read(path),created};
  }
  private async stateWrite(state: State) {
    const path = this.path(state.operation_id, 'state');
    // Refuse an existing symlink; rename replaces only this selected local state file.
    try { await this.read(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw safeError(); }
    const temp = join(this.directory, `${state.operation_id}.${randomUUID()}.tmp`);
    const fd = await open(temp, 'wx', 0o600);
    try {
      await fd.writeFile(JSON.stringify(state, null, 2) + '\n'); await fd.sync(); await fd.close();
      await rename(temp, path);
    } catch { await fd.close().catch(() => {}); await unlink(temp).catch(() => {}); throw safeError(); }
  }
  private validate(request: Request, kind: State['kind']) {
    if (request.project_id !== this.projectId || !uuid.test(request.operation_id)) throw safeError();
    const { project_id: _project, ...args } = request;
    const parsed = (kind === 'submit' ? submitActivitySchema : reconcileActivitySchema).safeParse(args);
    if (!parsed.success) throw safeError(); // Never log Zod errors with submitted text.
  }
  async prepare(request: Request, kind: State['kind'] = 'submit', parentOperationId?: string) {
    await this.directoryReady(); this.validate(request, kind);
    const {text,created} = await this.immutable(this.path(request.operation_id, 'request'), request);
    const initial: State = { schema_version: 1, kind, operation_id: request.operation_id,
      project_id: this.projectId, request_sha256: hash(text), status: created ? 'prepared' : 'unknown', attempts: 0, cycle_attempts: 0,
      ...(parentOperationId ? { parent_operation_id: parentOperationId } : {}) };
    try {
      const existing = parse(await this.read(this.path(request.operation_id, 'state'))) as State;
      if (existing.kind !== kind || existing.parent_operation_id !== parentOperationId || existing.request_sha256 !== hash(text)) throw safeError();
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw safeError(); await this.stateWrite(initial); }
    return this.inspect(request.operation_id);
  }
  async loadRequest(id: string): Promise<Request> {
    const state = parse(await this.read(this.path(id, 'state'))) as State;
    const text = await this.read(this.path(id, 'request'));
    if (state.schema_version !== 1 || state.operation_id !== id || state.project_id !== this.projectId ||
        state.request_sha256 !== hash(text)) throw safeError();
    const request = parse(text) as Request; this.validate(request, state.kind);
    return request;
  }
  async inspect(id: string) {
    await this.directoryReady(); await this.loadRequest(id);
    const state = parse(await this.read(this.path(id, 'state'))) as State;
    // A crash after receipt persistence but before state persistence is recoverable.
    try {
      const receipt = parse(await this.read(this.path(id, 'receipt')));
      this.applyReceipt(state, receipt);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw safeError(); }
    const action = ['applied', 'superseded'].includes(state.status) ? 'none'
      : state.needs_action || state.status === 'blocked' ? 'user_action'
      : state.status === 'pending' ? 'read_activity'
      : state.cycle_attempts >= 2 ? 'user_action'
      : state.kind === 'submit' ? 'submit_activity' : 'reconcile_activity';
    return { ...state, action, request_file: this.path(id, 'request'),
      notice: action === 'user_action' ? '작업 결과는 그대로야. 디로그 기록 복구에 조치가 필요해. 원 요청 파일을 보존했어.' : null };
  }
  async beginAttempt(id: string) {
    const { action, request_file: _file, notice: _notice, ...state } = await this.inspect(id);
    if (action !== 'submit_activity' && action !== 'reconcile_activity') throw safeError();
    state.previous_status = state.status; state.status = 'unknown'; state.attempts++; state.cycle_attempts++;
    await this.stateWrite(state);
    return this.loadRequest(id); // Exact persisted object, never reconstructed IDs/evidence/timestamps.
  }
  async noteFailure(id: string, reason: NonNullable<State['reason']>) {
    if (!['before_send', 'unknown', 'rejected', 'auth'].includes(reason)) throw safeError();
    const { action, request_file: _file, notice: _notice, ...state } = await this.inspect(id);
    if (action === 'none') return this.inspect(id);
    if (state.status === 'pending') { state.needs_action = true; state.reason = reason; await this.stateWrite(state); return this.inspect(id); }
    state.reason = reason;
    state.status = reason === 'auth' || reason === 'rejected' ? 'blocked'
      : reason === 'before_send' && state.previous_status !== 'unknown' ? 'not_sent' : 'unknown';
    await this.stateWrite(state); return this.inspect(id);
  }
  private applyReceipt(state: State, receipt: Record<string, unknown>) {
    const status = state.kind === 'submit' ? receipt.memory_status : receipt.status;
    if (!['pending', 'applied', 'superseded'].includes(String(status)) || typeof receipt.activity_id !== 'string' ||
        !uuid.test(receipt.activity_id) || !Number.isInteger(receipt.memory_version) || Number(receipt.memory_version) < 1 ||
        (state.activity_id && state.activity_id !== receipt.activity_id)) throw safeError();
    if (Number(receipt.memory_version) < (state.memory_version ?? 0)) return;
    state.status = status as State['status']; state.activity_id = receipt.activity_id; state.memory_version = Number(receipt.memory_version);
    delete state.reason;
    if (state.status === 'applied' || state.status === 'superseded') delete state.needs_action;
  }
  async recordReceipt(id: string, receipt: Record<string, unknown>) {
    const { action: _action, request_file: _file, notice: _notice, ...state } = await this.inspect(id);
    this.applyReceipt(state, receipt);
    await this.immutable(this.path(id, 'receipt'), receipt); await this.stateWrite(state);
    if (state.kind === 'reconcile' && state.parent_operation_id) {
      await this.observeActivity(state.parent_operation_id, { id: state.activity_id,
        memory_status: state.status, memory_version: state.memory_version });
    }
    return this.inspect(id);
  }
  async prepareReconcile(parentId: string, request: Request) {
    const parent = await this.inspect(parentId);
    if (parent.status !== 'pending' || parent.needs_action || request.activity_id !== parent.activity_id ||
        request.expected_memory_version !== parent.memory_version || request.operation_id === parentId) throw safeError();
    return this.prepare(request, 'reconcile', parentId);
  }
  async observeActivity(id: string, activity: Record<string, unknown>) {
    const { action: _action, request_file: _file, notice: _notice, ...state } = await this.inspect(id);
    if (!state.activity_id || state.activity_id !== activity.id) throw safeError();
    this.applyReceipt(state, { activity_id: activity.id, memory_status: activity.memory_status,
      status: activity.memory_status, memory_version: activity.memory_version });
    await this.stateWrite(state); return this.inspect(id);
  }
  async resume(id: string) {
    const { action, request_file: _file, notice: _notice, ...state } = await this.inspect(id);
    if (action === 'none') return this.inspect(id);
    state.cycle_attempts = 0; delete state.needs_action; delete state.reason;
    if (state.status === 'blocked') state.status = 'unknown';
    await this.stateWrite(state); return this.inspect(id);
  }
  /** Bounded discovery, not a sender. Never exposes request/source bodies. */
  async scan(limit = 100, afterId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw safeError();
    if (afterId && !uuid.test(afterId)) throw safeError();
    let names: string[];
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.directory) !== this.directory) throw safeError();
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], truncated: false, next_cursor: null, last_recorded_at: null };
      throw safeError();
    }
    const ids = [...new Set(names.filter(n => /\.(request|state)\.json$/.test(n)).map(n => n.split('.')[0]).filter(id => uuid.test(id) && (!afterId || id > afterId)))].sort();
    const items: { operation_id: string; status: string; action: string; request_file: string }[] = [];
    let lastRecorded: string | null = null;
    for (const id of ids.slice(0, limit)) {
      try {
        const request = parse(await this.read(this.path(id, 'request'))) as Request;
        if (!request || request.operation_id !== id || typeof request.project_id !== 'string' || !request.project_id) throw safeError();
        if (names.includes(`${id}.state.json`)) {
          const saved = parse(await this.read(this.path(id, 'state'))) as State;
          if (saved.project_id !== request.project_id || saved.operation_id !== id) throw safeError();
        }
        if (request.project_id !== this.projectId) continue;
        if (!names.includes(`${id}.state.json`)) {
          // Old submit requests may be imported conservatively; a reconcile needs its known parent.
          this.validate(request, 'submit');
          await this.prepare(request);
        }
        const state = await this.inspect(id);
        if (state.action !== 'none') items.push({ operation_id: id, status: state.status, action: state.action, request_file: state.request_file });
        else if (typeof request.occurred_at === 'string' && (!lastRecorded || request.occurred_at > lastRecorded)) lastRecorded = request.occurred_at;
      } catch { items.push({ operation_id: id, status: 'unavailable', action: 'inspect_privately', request_file: this.path(id, 'request') }); }
    }
    return { items, truncated: ids.length > limit, next_cursor: ids.length > limit ? ids[limit - 1] : null, last_recorded_at: lastRecorded };
  }
}

// Optional agent CLI: outputs metadata only, never request/result/source bodies or raw errors.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); if (at < 0) throw safeError(); const value = args[at + 1]; if (!value) throw safeError(); args.splice(at, 2); return value; };
  try {
    const root = option('--root');
    const projectId = option('--project');
    const journal = new RecoveryJournal(join(resolve(root), '.local', 'developlog-activity'), projectId);
    const [command, id, file] = args;
    let output;
    if (command === 'scan') output = await journal.scan(100, id);
    else if (command === 'prepare') output = await journal.prepare(JSON.parse(await readFile(id, 'utf8')));
    else if (command === 'status') output = await journal.inspect(id);
    else if (command === 'begin') { await journal.beginAttempt(id); output = {...await journal.inspect(id),action:'send_saved_request'}; }
    else if (command === 'failure') output = await journal.noteFailure(id, file as NonNullable<State['reason']>);
    else if (command === 'receipt') output = await journal.recordReceipt(id, JSON.parse(await readFile(file, 'utf8')));
    else if (command === 'reconcile') output = await journal.prepareReconcile(id, JSON.parse(await readFile(file, 'utf8')));
    else if (command === 'observed') output = await journal.observeActivity(id, JSON.parse(await readFile(file, 'utf8')));
    else if (command === 'resume') output = await journal.resume(id);
    else throw safeError();
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch { process.stderr.write('Recovery journal unavailable; preserve the selected request and inspect privately.\n'); process.exitCode = 1; }
}
