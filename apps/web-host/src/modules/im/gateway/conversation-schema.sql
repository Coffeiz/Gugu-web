-- 显式迁移审查后仅在隔离schema或已备份目标执行；服务启动不自动建表。
-- 正文仍以conversation_messages为准；sealed_payload仅保存恢复所需的加密平台材料。
BEGIN;
CREATE TABLE gugu_im_inbound_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('group','c2c')),
  scope_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL CHECK(state IN ('staged','passive','dispatched')),
  run_id varchar(128),
  sealed_payload jsonb NOT NULL,
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash),
  CHECK((state IN ('staged','passive') AND run_id IS NULL) OR (state='dispatched' AND run_id IS NOT NULL))
);
CREATE INDEX ix_gugu_im_inbound_run ON gugu_im_inbound_receipts(user_id,session_id,run_id) WHERE run_id IS NOT NULL;
CREATE TABLE gugu_im_inbound_segments (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('group','c2c')),
  scope_hash char(64) NOT NULL,
  segment_key char(64) NOT NULL,
  batch_key char(64) NOT NULL,
  segment_index integer NOT NULL CHECK(segment_index>=0),
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL CHECK(state IN ('started','completed')),
  mode varchar(16) NOT NULL CHECK(mode IN ('dispatch','passive')),
  run_id varchar(128),
  anchors jsonb NOT NULL CHECK(jsonb_typeof(anchors)='array' AND jsonb_array_length(anchors)>0),
  sealed_payload jsonb NOT NULL,
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,segment_key),
  CHECK((state='started' AND run_id IS NULL) OR (state='completed' AND ((mode='dispatch' AND run_id IS NOT NULL) OR (mode='passive' AND run_id IS NULL))))
);
CREATE UNIQUE INDEX uq_gugu_im_segment_run ON gugu_im_inbound_segments(user_id,session_id,run_id) WHERE run_id IS NOT NULL;
CREATE TABLE gugu_im_inbound_batch_members (
  user_id uuid NOT NULL, platform varchar(20) NOT NULL, bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL, scope_hash char(64) NOT NULL, event_hash char(64) NOT NULL,
  segment_key char(64) NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash),
  UNIQUE(user_id,platform,bot_id,chat_type,scope_hash,segment_key,ordinal),
  FOREIGN KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash)
    REFERENCES gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash) ON DELETE CASCADE,
  FOREIGN KEY(user_id,platform,bot_id,chat_type,scope_hash,segment_key)
    REFERENCES gugu_im_inbound_segments(user_id,platform,bot_id,chat_type,scope_hash,segment_key) ON DELETE CASCADE
);
COMMIT;
