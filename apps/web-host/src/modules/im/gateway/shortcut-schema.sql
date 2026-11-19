-- 显式审查并备份后迁移；启动不自动建表。仅保存控制目标，不保存正文或原生事件标识。
CREATE TABLE gugu_im_shortcut_controls (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_hash char(64) NOT NULL,
  reference uuid NOT NULL UNIQUE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  dispatch_sequence bigint NOT NULL,
  facts_hash char(64) NOT NULL,
  state varchar(16) NOT NULL CHECK(state IN ('observed','requested')),
  notification_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,event_hash),
  FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_dispatch(user_id,session_id,run_id) ON DELETE CASCADE
);
