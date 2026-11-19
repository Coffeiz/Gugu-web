-- 永久消费标记不随历史消息/会话裁剪级联删除；只存HMAC身份与指纹，不存正文。
BEGIN;
CREATE TABLE gugu_im_retired_inbound (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('c2c','group')),
  scope_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash)
);
COMMIT;
