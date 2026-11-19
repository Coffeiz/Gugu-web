-- 显式审查及备份后迁移；服务不得自动应用。平台message仅保存purpose HMAC，不保存token。
CREATE TABLE gugu_im_native_deliveries (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_hash char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  prompt_id integer NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
  state varchar(12) NOT NULL CHECK(state IN ('pending','accepted','rejected','unknown')),
  attempt_id uuid NOT NULL,
  PRIMARY KEY(user_id,delivery_hash)
);
CREATE TABLE gugu_im_native_prompt_messages (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(16) NOT NULL CHECK(platform IN ('feishu','qq','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_hash char(64) NOT NULL,
  message_hash char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  prompt_id integer NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,platform,bot_id,message_hash)
);
