-- 显式迁移：控制收据不含正文、平台凭据或模型密钥；过期未知请求不得自动重新摘要。
BEGIN;
CREATE TABLE gugu_im_compact_commands (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  session_id integer REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  operation_id varchar(128) NOT NULL,
  state text NOT NULL CHECK (state IN ('requesting','compacted','not_needed','failed','unknown','busy','no_session')),
  token text,
  fence bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,event_hash),
  UNIQUE(user_id,operation_id)
);
CREATE INDEX gugu_im_compact_session ON gugu_im_compact_commands(user_id,session_id);
COMMIT;
