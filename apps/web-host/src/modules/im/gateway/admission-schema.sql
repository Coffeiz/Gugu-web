-- 准入元数据默认不设TTL。旧事件不能因seen过期或重启而重新作用于新的秘密/选项/取消目标。
-- 正文、回复token、媒体密钥均不入表；fingerprint与scope/event标识均为部署密钥HMAC。
BEGIN;
CREATE TABLE gugu_im_gateway_admissions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id integer NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('c2c','group')),
  scope_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  state varchar(16) NOT NULL CHECK(state IN ('pending','admitted','consumed','unknown')),
  token varchar(128),
  first_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash),
  CHECK((state='pending' AND token IS NOT NULL) OR (state<>'pending' AND token IS NULL))
);
CREATE INDEX ix_gugu_im_gateway_admission_health ON gugu_im_gateway_admissions(user_id,bot_id,state) WHERE state IN ('pending','unknown');
COMMIT;
