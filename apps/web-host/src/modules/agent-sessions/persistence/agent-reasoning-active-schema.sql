-- Node运行中私有推理，仅显式审查迁移；不得启动时自动建表或替代成功会话状态。
BEGIN;
CREATE TABLE gugu_agent_active_reasoning (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  checkpoint_version bigint NOT NULL CHECK(checkpoint_version>=0),
  ref_hash varchar(64) NOT NULL,
  context_hash varchar(64) NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 16 AND 16777232),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,session_id,run_id),
  FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_checkpoints(user_id,session_id,run_id) ON DELETE CASCADE
);
COMMIT;
