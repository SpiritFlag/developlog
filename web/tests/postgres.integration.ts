import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { database } from '../lib/db';
import type { Actor } from '../lib/model';
import { createProject, commitChanges, readTopic, readRecord, readProject } from '../lib/service';
import { submitActivity, reconcileActivity } from '../lib/activity-service';
import { readActivity, listActivities, listHistory } from '../lib/activity-read';
import { submitActivitySchema, type ActivityInput } from '../lib/activity-model';
import { createProjectMcp } from '../lib/mcp-server';

// Never read .env or fall back to DATABASE_URL. Only an explicit, empty loopback DB is eligible.
const inputUrl = process.env.DEVELOPLOG_TEST_DATABASE_URL;
if (!inputUrl) throw new Error('Set DEVELOPLOG_TEST_DATABASE_URL to an empty local integration database.');
let local: URL;
try { local = new URL(inputUrl); } catch { throw new Error('Invalid local integration database URL.'); }
if (!['postgres:', 'postgresql:'].includes(local.protocol) ||
    !['127.0.0.1', '[::1]'].includes(local.hostname) ||
    !/^\/developlog_integration_[a-z0-9_]+$/.test(local.pathname) || local.search || local.hash)
  throw new Error('Integration tests require a loopback host, developlog_integration_ database name and no URL options.');

const previousDatabase = process.env.DATABASE_URL;
const previousOwner = process.env.DEVELOPLOG_OWNER_ID;
const ownerId = 'synthetic-postgres-owner';
const admin = new Pool({ connectionString: inputUrl, connectionTimeoutMillis: 5000 });
const db = database;
const when = '2026-10-12T16:30:00.000Z';

before(async () => {
  const tables = await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')");
  assert.equal(tables.rows[0].n, 0, 'Refusing to initialize a nonempty database. Use a new empty integration database.');
  const schema = await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8');
  await admin.query(`BEGIN;\n${schema}\nCOMMIT;`);
  process.env.DATABASE_URL = inputUrl;
  process.env.DEVELOPLOG_OWNER_ID = ownerId;
  const info = await db().query<{ version: string; address: string; port: number }>(
    'SELECT version(), host(inet_server_addr()) AS address, inet_server_port() AS port');
  assert.ok(info.rows[0].version.startsWith('PostgreSQL '));
  assert.ok(['127.0.0.1', '::1'].includes(info.rows[0].address));
  console.log(`Real PostgreSQL: ${info.rows[0].version.split(' on ')[0]}, loopback port ${info.rows[0].port}`);
});

after(async () => {
  await admin.end();
  const globalDb = globalThis as unknown as { developlogPool?: Pool };
  await globalDb.developlogPool?.end();
  delete globalDb.developlogPool;
  if (previousDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabase;
  if (previousOwner === undefined) delete process.env.DEVELOPLOG_OWNER_ID;
  else process.env.DEVELOPLOG_OWNER_ID = previousOwner;
});

async function fixture(): Promise<Actor> {
  const actor: Actor = { id: ownerId, kind: 'ai', projectId: randomUUID() };
  await createProject(db(), actor, { project_id: actor.projectId, name: 'Synthetic PostgreSQL verification', purpose: 'Isolated integration only', timezone: 'Asia/Seoul' });
  await commitChanges(db(), actor, { operation_id: randomUUID(), read_set: [], reason: 'Set up synthetic Topic and Work', changes: [
    { type: 'save_topic', topic_id: 'cache', expected_version: 0, title: 'Cache', slug: 'cache', intro: 'Synthetic caching behavior' },
    { type: 'set_design', topic_id: 'cache', expected_version: 0, rule_id: 'ttl', title: 'Expiry', design: { text: 'Entries expire after one minute' } },
    { type: 'save_record', id: 'work', expected_version: 0, record: { kind: 'work', title: 'Verify expiry', state: 'ready', topic_ids: ['cache'], acceptance: 'Expiry test passes',
      acceptance_criteria: [{ id: 'expiry', text: 'Expiry test passes', required_method: 'automated_test' }], recommendation: { model: 'Sol', reasoning: 'Medium', reason: 'One isolated verification' } } },
  ] });
  return actor;
}

async function submission(actor: Actor): Promise<ActivityInput> {
  const topic = (await readTopic(db(), actor, 'cache')).topic;
  const source = randomUUID();
  const evidence = { source_id: source, method: 'automated_test', scope: 'Synthetic expiry specification', target: 'Local integration fixture', observed_at: when };
  return submitActivitySchema.parse({ operation_id: randomUUID(), result_key: randomUUID(), channel: 'connected', topic_ids: ['cache'], summary: 'Synthetic expiry observation',
    result: `Synthetic execution ${randomUUID()} passed; external authentication was not tested.`, occurred_at: when,
    sources: [{ id: source, title: 'Synthetic test log', body: 'expiry specification passed', origin: 'test', observed_at: when }],
    verification: [{ id: 'test', ...evidence, outcome: 'passed' }],
    memory: { read_set: [{ topic_id: 'cache', context_version: topic.context_version }], changes: [
      { type: 'confirm_actual', topic_id: 'cache', expected_version: topic.version, rule_id: 'ttl', actual: { text: 'Entries expire after one minute', evidence: [evidence] }, resolves_report: false },
      { type: 'set_gap', topic_id: 'cache', expected_version: topic.version, rule_id: 'ttl', gap: { state: 'aligned', reason: 'Synthetic specification matches design' } },
    ], reason: 'Verify synthetic memory round trip' },
    history: { significance: 'behavior', summary: 'Synthetic behavior established', reason: 'Verify linked History storage', topic_ids: ['cache'], evidence_ids: ['test'] },
  });
}

async function count(actor: Actor, table: 'activities' | 'evidence' | 'sources' | 'history') {
  return (await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE project_id=$1`, [actor.projectId])).rows[0].n;
}

test('pg adapter: empty schema, Project → Topic/Work → Activity/Evidence/History and rollback', { timeout: 20000 }, async () => {
  const actor = await fixture();
  const input = await submission(actor);
  input.work_id = 'work';
  input.memory.work_result = { expected_version: 1, conclusion: 'verified_complete', checks: [{ criterion_id: 'expiry', satisfied: true, evidence_ids: ['test'], note: 'Synthetic expiry specification passed' }] };
  const result = await submitActivity(db(), actor, input);
  assert.equal(result.memory_status, 'applied');
  assert.equal((await readTopic(db(), actor, 'cache')).topic.rules[0].actual?.evidence[0].method, 'automated_test');
  const work = (await readRecord(db(), actor, 'work')).record;
  assert.equal(work.state, 'done');
  assert.equal(work.recommendation?.model, 'Sol');
  assert.equal(work.recommendation?.reasoning, 'Medium');
  const history = await listHistory(db(), actor, { date: '2026-10-13' });
  assert.equal(history.items.length, 1);
  assert.equal((history.items[0] as unknown as { project_date: string }).project_date, '2026-10-13');
  assert.equal((await listHistory(db(), actor, { date: '2026-10-12' })).items.length, 0);
  assert.equal((await readActivity(db(), actor, result.activity_id)).activity.memory_status, 'applied');
  await assert.rejects(db().query("UPDATE activities SET result='rewritten' WHERE project_id=$1", [actor.projectId]), /immutable/);
  const bad = await submission(actor);
  bad.verification[0].source_id = 'missing-source';
  await assert.rejects(submitActivity(db(), actor, bad));
  for (const table of ['activities', 'sources', 'evidence', 'history'] as const) assert.equal(await count(actor, table), 1);
  await assert.rejects(readProject(db(), { ...actor, id: 'synthetic-intruder' }), /접근/);
});

test('pg savepoint: stale Work preserves execution, rolls back Topic, then reconciles once', { timeout: 20000 }, async () => {
  const actor = await fixture();
  const input = await submission(actor);
  input.work_id = 'work';
  input.memory.work_result = { expected_version: 99, conclusion: 'verified_complete', checks: [{ criterion_id: 'expiry', satisfied: true, evidence_ids: ['test'], note: 'Passed locally' }] };
  const beforeTopic = (await readTopic(db(), actor, 'cache')).topic;
  const pending = await submitActivity(db(), actor, input);
  assert.equal(pending.memory_status, 'pending');
  assert.deepEqual((await readTopic(db(), actor, 'cache')).topic, beforeTopic);
  assert.equal((await readProject(db(), actor)).pending_activities.items[0].id, pending.activity_id);
  assert.equal(((await listHistory(db(), actor)).items[0] as unknown as { memory_status: string }).memory_status, 'pending');
  const original = (await readActivity(db(), actor, pending.activity_id)).activity;
  input.memory.work_result.expected_version = 1;
  const retry = { operation_id: randomUUID(), activity_id: pending.activity_id, expected_memory_version: 1, memory: input.memory };
  const applied = await reconcileActivity(db(), actor, retry);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.memory_version, 2);
  assert.deepEqual(await reconcileActivity(db(), actor, retry), applied);
  const final = await readActivity(db(), actor, pending.activity_id);
  assert.deepEqual(final.activity.payload, original.payload);
  assert.equal(final.activity.result, original.result);
  assert.equal(final.attempts.length, 2);
  assert.equal((await listActivities(db(), actor, { status: 'pending' })).items.length, 0);
  assert.equal((await readRecord(db(), actor, 'work')).record.state, 'done');
  assert.equal(((await listHistory(db(), actor)).items[0] as unknown as { memory_status: string }).memory_status, 'applied');
  for (const table of ['activities', 'sources', 'evidence', 'history'] as const) assert.equal(await count(actor, table), 1);
});

test('pg pool: concurrent identical retries deduplicate; stale writer remains pending', { timeout: 20000 }, async () => {
  const actor = await fixture();
  const input = await submission(actor);
  const [a, b] = await Promise.all([submitActivity(db(), actor, input), submitActivity(db(), actor, input)]);
  assert.deepEqual(a, b);
  assert.equal(await count(actor, 'activities'), 1);
  const other = await fixture();
  const [first, second] = await Promise.all([submission(other), submission(other)]);
  const results = await Promise.all([submitActivity(db(), other, first), submitActivity(db(), other, second)]);
  assert.deepEqual(results.map(r => r.memory_status).sort(), ['applied', 'pending']);
  assert.equal(await count(other, 'activities'), 2);
  assert.equal((await listActivities(db(), other, { status: 'pending' })).items.length, 1);
});

test('loopback HTTP MCP initialize/discovery/submit/read/history/reconcile against pg (synthetic identity)', { timeout: 30000 }, async () => {
  const actor = await fixture();
  const handler = createProjectMcp();
  // This private test server supplies a synthetic identity. It does not load or bypass the app's Clerk/OAuth routes.
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const userId = headers.get('x-synthetic-user');
      if (userId) request.auth = { token: 'synthetic-test-only', clientId: 'loopback-integration', scopes: [], extra: { userId } };
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end('Test transport failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'local-pg-integration', version: '1.0.0' });
  const anonymous = new Client({ name: 'local-anonymous', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-synthetic-user': ownerId } } }));
    const tools = await client.listTools();
    for (const name of ['submit_activity', 'read_activity', 'list_history', 'reconcile_activity']) assert.ok(tools.tools.some(t => t.name === name));
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: { project_id: actor.projectId, ...args } });
      assert.ok(!result.isError, JSON.stringify(result));
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0].text);
    }
    const input = await submission(actor);
    input.memory.read_set[0].context_version = 999;
    const pending = await call('submit_activity', input);
    assert.equal(pending.memory_status, 'pending');
    assert.equal((await call('read_activity', { id: pending.activity_id })).activity.memory_status, 'pending');
    const current = (await readTopic(db(), actor, 'cache')).topic;
    input.memory.read_set[0].context_version = current.context_version;
    assert.equal((await call('reconcile_activity', { operation_id: randomUUID(), activity_id: pending.activity_id, expected_memory_version: 1, memory: input.memory })).status, 'applied');
    assert.equal((await call('list_history', { date: '2026-10-13' })).items[0].memory_status, 'applied');
    await anonymous.connect(new StreamableHTTPClientTransport(url));
    const denied = await anonymous.callTool({ name: 'submit_activity', arguments: { project_id: actor.projectId, ...input } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse((denied.content as { text: string }[])[0].text).status, 401);
    assert.equal(await count(actor, 'activities'), 1);
  } finally {
    await Promise.all([client.close(), anonymous.close()]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
