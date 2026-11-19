-- Node内部pending ASK唤醒收据；备份审查后显式迁移，服务启动不得自动建表。
BEGIN;
CREATE TABLE gugu_im_pending_ask_runs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('qq','feishu','telegram')),
  bot_id varchar(128) NOT NULL,
  scope_hash char(64) NOT NULL,
  resume_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL CHECK(state IN ('dispatched','consumed')),
  run_id varchar(128),
  PRIMARY KEY(user_id,platform,bot_id,scope_hash,resume_hash),
  CHECK((state='dispatched' AND run_id IS NOT NULL) OR (state='consumed' AND run_id IS NULL))
);
COMMIT;
