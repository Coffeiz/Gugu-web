-- Node私聊显式绑定；不读取或清理Python的Redis路由键，必须显式迁移。
BEGIN;
CREATE TABLE gugu_im_owner_sessions (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,scope_hash)
);
CREATE TABLE gugu_im_owner_session_receipts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 run_id text NOT NULL,
 round_id text NOT NULL,
 call_id text NOT NULL,
 scope_hash text NOT NULL,
 target_session_id integer NOT NULL,
 status text NOT NULL CHECK(status IN ('bound','denied')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,session_id,run_id,round_id,call_id)
);
COMMIT;
