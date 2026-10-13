import { PGlite } from '@electric-sql/pglite';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Deliberately ignores DATABASE_URL and all external service credentials.
const schema = await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8');
const schemaId = createHash('sha256').update(schema).digest('hex').slice(0,12);
const path = resolve(`.local/developlog-v3-${schemaId}`);
await mkdir(resolve('.local'),{recursive:true});
const db = new PGlite(path);
try {
  const {rows} = await db.query<{count:number}>("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
  if (rows[0].count) throw new Error('Local database is not empty; refusing to overwrite it.');
  await db.exec(`BEGIN;\n${schema}\nCOMMIT;`);
  console.log(`Initialized empty local PGlite database: ${path}`);
} finally { await db.close(); }
