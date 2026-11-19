-- Node专用反思任务；先审查/备份，显式应用。不得由启动入口自动执行。
BEGIN;
CREATE TABLE gugu_im_reflection_owner_revisions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE gugu_im_reflection_run_revisions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  owner_revision bigint NOT NULL CHECK(owner_revision>=0),
  scope_versions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(scope_versions)='object'),
  PRIMARY KEY(user_id,session_id,run_id)
);
CREATE TABLE gugu_im_reflection_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  scope_hash varchar(64) NOT NULL,
  scope_version integer NOT NULL CHECK(scope_version>=0),
  window_key varchar(128) NOT NULL DEFAULT 'run',
  state varchar(16) NOT NULL CHECK(state IN ('pending','ready','running','prepared','retry','deferred','completed','cancelled','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=5),
  token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '3 minutes',
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 16 AND 1048592),
  plan_nonce bytea,
  plan_payload bytea,
  last_error_code varchar(32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,session_id,run_id,scope_hash,window_key),
  CHECK((plan_nonce IS NULL)=(plan_payload IS NULL)),
  CHECK(plan_nonce IS NULL OR octet_length(plan_nonce)=12),
  CHECK(plan_payload IS NULL OR octet_length(plan_payload) BETWEEN 16 AND 16777232)
);
CREATE INDEX ix_gugu_im_reflection_ready ON gugu_im_reflection_jobs(next_attempt_at,created_at)
  WHERE state IN ('pending','ready','running','prepared','retry','deferred');
CREATE TABLE gugu_im_reflection_cursor_positions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  scope_hash varchar(64) NOT NULL,
  scope_version integer NOT NULL CHECK(scope_version>=0),
  last_sequence bigint NOT NULL CHECK(last_sequence>0),
  last_message_id integer NOT NULL,
  PRIMARY KEY(user_id,session_id,scope_hash,scope_version)
);
COMMIT;
