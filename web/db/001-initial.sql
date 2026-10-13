-- Developlog 3.0: empty databases only. No migration from an earlier schema.
CREATE TABLE projects (
  id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
  description text NOT NULL DEFAULT '', purpose text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'handoff' CHECK (mode IN ('connected','handoff')),
  timezone text NOT NULL DEFAULT 'Asia/Seoul', github_repository text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner ON projects(owner_id,id);
CREATE TABLE topics (
  project_id text NOT NULL REFERENCES projects(id), id text NOT NULL,
  title text NOT NULL, slug text NOT NULL, intro text NOT NULL DEFAULT '',
  aliases jsonb NOT NULL DEFAULT '[]', rules jsonb NOT NULL DEFAULT '[]',
  detail text NOT NULL DEFAULT '', source_ids jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL CHECK (version > 0),
  context_version integer NOT NULL DEFAULT 0 CHECK (context_version >= 0),
  position integer NOT NULL DEFAULT 50, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id), UNIQUE(project_id,slug),
  CHECK (jsonb_typeof(rules) = 'array')
);
CREATE TABLE sources (
  project_id text NOT NULL REFERENCES projects(id), id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human','ai')), title text NOT NULL,
  body text NOT NULL, url text, ref text,
  origin text NOT NULL CHECK (origin IN ('intent','report','document','code','test','observation')),
  captured_by text, observed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(project_id,id)
);
-- Work and the existing context/history cards share their display envelope.
-- The works/history views below expose the domain entities without duplicating truth.
CREATE TABLE records (
  project_id text NOT NULL REFERENCES projects(id), id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('work','context','event')),
  title text NOT NULL, summary text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  state text NOT NULL, acceptance text NOT NULL DEFAULT '',
  acceptance_criteria jsonb NOT NULL DEFAULT '[]', recommendation jsonb,
  resolution text NOT NULL DEFAULT '', reason text NOT NULL DEFAULT '',
  depends_on jsonb NOT NULL DEFAULT '[]', derived_from jsonb NOT NULL DEFAULT '[]',
  parent_id text, source_ids jsonb NOT NULL DEFAULT '[]', evidence jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL CHECK (version > 0), occurred_at timestamptz,
  issue_key text, generated_by_activity text, activity_id text,
  approved_at timestamptz, approved_by text,
  significance text CHECK (significance IN ('design','behavior','correction','milestone')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id), FOREIGN KEY(project_id,parent_id) REFERENCES records(project_id,id),
  CHECK ((kind='work' AND state IN ('candidate','ready','active','blocked','done','cancelled'))
    OR (kind='context' AND state IN ('active','resolved'))
    OR (kind='event' AND state IN ('published','corrected'))),
  CHECK (kind <> 'event' OR (occurred_at IS NOT NULL AND length(trim(reason)) > 0)),
  CHECK (kind = 'work' OR (issue_key IS NULL AND generated_by_activity IS NULL))
);
CREATE UNIQUE INDEX work_issue_identity ON records(project_id,issue_key) WHERE kind='work' AND issue_key IS NOT NULL;
CREATE INDEX records_cards ON records(project_id,kind,state,updated_at DESC,id);
CREATE TABLE work_issue_keys (
  project_id text NOT NULL, issue_key text NOT NULL, work_id text NOT NULL,
  PRIMARY KEY(project_id,issue_key),
  FOREIGN KEY(project_id,work_id) REFERENCES records(project_id,id)
);
CREATE INDEX history_dates ON records(project_id,occurred_at DESC,id) WHERE kind='event';
CREATE TABLE record_topics (
  project_id text NOT NULL, record_id text NOT NULL, topic_id text NOT NULL,
  PRIMARY KEY(project_id,record_id,topic_id),
  FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id),
  FOREIGN KEY(project_id,topic_id) REFERENCES topics(project_id,id)
);
CREATE TABLE activities (
  project_id text NOT NULL REFERENCES projects(id), id text NOT NULL,
  result_key text NOT NULL, result_hash text NOT NULL, actor_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('connected','handoff')),
  work_id text, summary text NOT NULL, result text NOT NULL,
  occurred_at timestamptz NOT NULL, payload jsonb NOT NULL,
  memory_status text NOT NULL CHECK (memory_status IN ('pending','applied','superseded')),
  memory_version integer NOT NULL DEFAULT 0, conflicts jsonb NOT NULL DEFAULT '[]',
  corrects_activity_id text, correction_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id), UNIQUE(project_id,result_key), UNIQUE(project_id,result_hash),
  FOREIGN KEY(project_id,work_id) REFERENCES records(project_id,id),
  FOREIGN KEY(project_id,corrects_activity_id) REFERENCES activities(project_id,id),
  CHECK ((corrects_activity_id IS NULL) = (correction_reason IS NULL))
);
ALTER TABLE records ADD FOREIGN KEY(project_id,activity_id) REFERENCES activities(project_id,id);
ALTER TABLE records ADD FOREIGN KEY(project_id,generated_by_activity) REFERENCES activities(project_id,id);
CREATE INDEX activities_pending ON activities(project_id,memory_status,created_at,id);
CREATE TABLE activity_topics (
  project_id text NOT NULL, activity_id text NOT NULL, topic_id text NOT NULL,
  PRIMARY KEY(project_id,activity_id,topic_id),
  FOREIGN KEY(project_id,activity_id) REFERENCES activities(project_id,id),
  FOREIGN KEY(project_id,topic_id) REFERENCES topics(project_id,id)
);
CREATE TABLE evidence (
  project_id text NOT NULL, id text NOT NULL, activity_id text NOT NULL, source_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('documented','code_read','automated_test','user_observation')),
  scope text NOT NULL, target text NOT NULL, observed_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('passed','failed','observed','not_run')),
  PRIMARY KEY(project_id,id),
  FOREIGN KEY(project_id,activity_id) REFERENCES activities(project_id,id),
  FOREIGN KEY(project_id,source_id) REFERENCES sources(project_id,id)
);
CREATE TABLE activity_memory_revisions (
  project_id text NOT NULL, activity_id text NOT NULL, version integer NOT NULL,
  operation_id text NOT NULL, proposal jsonb NOT NULL, result jsonb NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,activity_id,version),
  FOREIGN KEY(project_id,activity_id) REFERENCES activities(project_id,id)
);
CREATE TABLE operations (
  project_id text NOT NULL REFERENCES projects(id), id text NOT NULL, actor_id text NOT NULL,
  request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,id)
);
CREATE TABLE knowledge_revisions (
  project_id text NOT NULL REFERENCES projects(id), id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('topic','record')), entity_id text NOT NULL,
  version integer NOT NULL, snapshot jsonb NOT NULL, reason text NOT NULL,
  actor_id text NOT NULL, actor_kind text NOT NULL, operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,id),
  UNIQUE(project_id,entity_type,entity_id,version)
);
CREATE VIEW works AS SELECT * FROM records WHERE kind='work';
CREATE VIEW history AS
  SELECT r.*, (r.occurred_at AT TIME ZONE p.timezone)::date AS project_date
  FROM records r JOIN projects p ON p.id=r.project_id WHERE r.kind='event';

-- Provenance and revision snapshots are append-only, even if a future writer is buggy.
CREATE FUNCTION reject_archive_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'archive rows are immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER immutable_sources BEFORE UPDATE OR DELETE ON sources FOR EACH ROW EXECUTE FUNCTION reject_archive_mutation();
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION reject_archive_mutation();
CREATE TRIGGER immutable_revisions BEFORE UPDATE OR DELETE ON knowledge_revisions FOR EACH ROW EXECUTE FUNCTION reject_archive_mutation();
CREATE TRIGGER immutable_operations BEFORE UPDATE OR DELETE ON operations FOR EACH ROW EXECUTE FUNCTION reject_archive_mutation();
CREATE TRIGGER immutable_memory_attempts BEFORE UPDATE OR DELETE ON activity_memory_revisions FOR EACH ROW EXECUTE FUNCTION reject_archive_mutation();
CREATE FUNCTION protect_activity_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'execution reports are immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW) - ARRAY['memory_status','memory_version','conflicts']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['memory_status','memory_version','conflicts']) THEN
    RAISE EXCEPTION 'execution reports are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_execution BEFORE UPDATE OR DELETE ON activities FOR EACH ROW EXECUTE FUNCTION protect_activity_execution();
