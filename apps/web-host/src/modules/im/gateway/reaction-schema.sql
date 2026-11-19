-- 显式审查后应用；运行服务不得自动迁移用户数据库。
BEGIN;
CREATE TABLE gugu_im_reaction_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  call_hash varchar(64) NOT NULL CHECK (call_hash ~ '^[a-f0-9]{64}$'),
  fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  attempt_id uuid NOT NULL,
  state varchar(12) NOT NULL CHECK (state IN ('pending','accepted','rejected','unknown')),
  PRIMARY KEY(user_id,session_id,run_id,call_hash)
);
COMMIT;
