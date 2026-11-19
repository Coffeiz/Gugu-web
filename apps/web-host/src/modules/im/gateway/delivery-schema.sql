-- 仅供显式审查和迁移：先备份并验证现有 users / conversation_sessions 类型及归属。
-- 禁止服务启动或测试对用户数据库自动执行。测试只在随机隔离 schema 应用。
-- 不改既有表；session没有(user_id,id)唯一约束，运行适配器每次以JOIN复核归属。
BEGIN;
CREATE TABLE gugu_im_run_delivery (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  PRIMARY KEY (user_id, session_id, run_id)
);
CREATE TABLE gugu_im_delivery_receipts (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  delivery_key varchar(200) NOT NULL,
  fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  state varchar(12) NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'unknown')),
  attempt_id uuid NOT NULL,
  PRIMARY KEY (user_id, session_id, run_id, delivery_key),
  FOREIGN KEY (user_id, session_id, run_id) REFERENCES gugu_im_run_delivery(user_id, session_id, run_id) ON DELETE CASCADE
);
CREATE TABLE gugu_im_platform_projection (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  platform varchar(16) NOT NULL CHECK (platform IN ('feishu','qq','telegram')),
  version bigint NOT NULL CHECK (version>0),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  payload bytea NOT NULL CHECK (octet_length(payload)<=1048592),
  PRIMARY KEY(user_id,session_id,run_id,platform),
  FOREIGN KEY(user_id,session_id,run_id) REFERENCES gugu_im_run_delivery(user_id,session_id,run_id) ON DELETE CASCADE
);
COMMIT;
