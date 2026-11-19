-- Node attention语音收据；必须显式审查/备份后迁移，不由运行时自动建表。
BEGIN;
CREATE TABLE gugu_im_voice_cache (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  attach_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('feishu','qq','telegram','wechat')),
  bot_id varchar(128) NOT NULL,
  scope_hash text NOT NULL,
  event_hash text NOT NULL,
  selection_hash text NOT NULL,
  input_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared','requesting','completed','empty','unavailable','unknown')),
  attempt text NOT NULL,
  nonce bytea,
  sealed_result bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,session_id,message_id,attach_id)
);
CREATE TABLE gugu_im_voice_run_bindings (
  source_key text NOT NULL REFERENCES gugu_im_voice_cache(source_key) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(source_key,run_id)
);
COMMIT;
