-- Node反思触发状态与窗口；显式审查迁移，启动时不自动建表。没有正文、凭据或平台原生身份。
BEGIN;
CREATE TABLE gugu_im_reflection_trigger_states(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 owner_revision bigint NOT NULL CHECK(owner_revision>=0),
 passive_count integer NOT NULL DEFAULT 0 CHECK(passive_count>=0 AND passive_count<50),
 through_message_id integer NOT NULL DEFAULT 0 CHECK(through_message_id>=0),
 through_message_seq bigint NOT NULL DEFAULT 0 CHECK(through_message_seq>=0),
 last_active_run_id varchar(128), active_at timestamptz, idle_due_at timestamptz,
 active_generation bigint NOT NULL DEFAULT 0 CHECK(active_generation>=0),
  observe_after timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,session_id),
 CHECK((last_active_run_id IS NULL)=(active_at IS NULL)),
 CHECK(idle_due_at IS NULL OR active_at IS NOT NULL)
);
CREATE TABLE gugu_im_reflection_trigger_observed(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 kind varchar(8) NOT NULL CHECK(kind IN('passive','active')),
 observation_key varchar(128) NOT NULL,
 owner_revision bigint NOT NULL CHECK(owner_revision>=0), ignored boolean NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,session_id,kind,observation_key)
);
CREATE TABLE gugu_im_reflection_trigger_windows(
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 owner_revision bigint NOT NULL CHECK(owner_revision>=0),
 through_message_id integer NOT NULL CHECK(through_message_id>0),
 through_message_seq bigint NOT NULL CHECK(through_message_seq>0),
 scope_versions jsonb NOT NULL CHECK(jsonb_typeof(scope_versions)='object'),
 run_id varchar(128),reason varchar(12) NOT NULL CHECK(reason IN('threshold','idle')),
 status varchar(12) NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='pending')=(completed_at IS NULL))
);
CREATE INDEX ix_gugu_im_reflection_trigger_due ON gugu_im_reflection_trigger_states(idle_due_at) WHERE idle_due_at IS NOT NULL;
CREATE INDEX ix_gugu_im_reflection_trigger_pending ON gugu_im_reflection_trigger_windows(next_attempt_at,created_at,id) WHERE status='pending';
COMMIT;
