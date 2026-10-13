# Developlog 3.0

Developlog keeps a project's current design, observed behavior, work, and meaningful history together. The web app uses Clerk for a single owner's login and exposes an authenticated MCP endpoint for connected tools and manual work handoffs.

## Application

- Next.js application root: `web`
- Runtime: Node.js 24; PostgreSQL through `pg`
- Authentication: existing Clerk application, web sessions and MCP OAuth
- Topic: adopted design, confirmed observations, unverified reports, and their differences
- Work: scope, prerequisites, acceptance criteria, manual instructions, and model recommendations
- Activity: immutable execution report and verification; conflicting memory updates remain pending
- History: meaningful changes linked to their original Activity
- Recommendations: Sol / Astra and Light / Medium / High / Extra High / Ultra; no automatic model switching

The web UI creates projects and reads Topics, Work, Activity results, and History. Work instructions can be copied for manual handoff. Planning and Activity submission/reconciliation are available through MCP; Activity submissions also have a same-origin web API contract. The UI does not run an agent or automatically execute approved Work.

## Local setup

```sh
cd web
npm ci
```

Copy `.env.example` to a private `.env.local` and configure a dedicated development Clerk instance and a separate PostgreSQL database. Do not copy production credentials into local development.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Isolated database connection; pooled connection for the deployed app |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk instance's publishable key |
| `CLERK_SECRET_KEY` | Private Clerk server credential |
| `DEVELOPLOG_OWNER_ID` | Allowed Clerk user ID; access fails closed when absent |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` |
| `NEXT_PUBLIC_APP_URL` | Public app origin |

Apply `web/db/001-initial.sql` only to an empty, explicitly selected database, inside one transaction. It is an initial schema, not a migration from previous versions. Never apply it to an existing service database. The application does not apply schema changes during startup or build.

`npm run db:init:local` creates a separate PGlite fixture under ignored `.local/`; it ignores `DATABASE_URL`. This fixture is for schema checks, not the app's TCP PostgreSQL connection.

```sh
npm run dev
npm run typecheck
npm test
npm run build
```

Real PostgreSQL integration tests require an explicit `DEVELOPLOG_TEST_DATABASE_URL` pointing to a loopback host (`127.0.0.1` or `::1`) and a fresh `developlog_integration_*` database. They refuse a nonempty database and never fall back to `DATABASE_URL`.

```sh
npm run test:postgres
```

Tests use synthetic data. Service, HTTP handler and MCP tests do not prove real Clerk login or OAuth authorization-code/refresh flows. Those require a separately configured authentication environment.

## Web and MCP contracts

The web API is `/api/workspace`. Reads use `view=projects|project|topics|topic|records|record|handoff|activities|activity|history` and a `project` identifier when applicable. Writes require Clerk owner authentication and matching `Origin`; supported actions are `create_project`, `submit_activity`, `reconcile_activity`, and `approve_candidate`.

The MCP toolset retains `list_projects`, `create_project`, `read_context`, `read_record`, `search_memory`, and `commit_changes`, and adds `submit_activity`, `reconcile_activity`, `list_activities`, `read_activity`, and `list_history`. Execution results use Activity submission; `commit_changes` is for planning, Topic setup, and explicit maintenance. Keep operation/result IDs stable on retries. A pending Activity preserves the report without falsely confirming current memory.

Production address contracts are `https://developlog.spiritflag.work` and `https://developlog.spiritflag.work/mcp`. OAuth discovery paths are `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. They currently advertise the production resource. Changing `NEXT_PUBLIC_APP_URL` alone does not reconfigure OAuth; configure and verify any development OAuth resource explicitly before testing it.

## Deployment boundary

The Vercel project uses Root Directory `web`. `web/vercel.json` disables automatic Git deployments during transition preparation. This does not block manual deployments or domain promotion. Keep the existing deployment available until database, login and OAuth smoke tests pass and a specific deployment is approved for promotion.

Environment files, generated output, local databases, internal preparation documents, and release audit files are excluded from Git. No historical database content or Git history is part of this source snapshot.

No open-source license has been selected. Public source visibility alone does not grant an open-source license. Image provenance is recorded in `web/public/ASSETS.md`.
