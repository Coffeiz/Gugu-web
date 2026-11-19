-- 仅用于已安装单消息 conversation-schema.sql 的隔离/受控数据库升级。
-- 新数据库直接执行最新 conversation-schema.sql；不要重复执行本升级。
-- 删除单消息run唯一索引后，单消息事务仍验证run未被其他消息占用；批次由segment唯一索引约束。
BEGIN;
DROP INDEX uq_gugu_im_inbound_run;
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
