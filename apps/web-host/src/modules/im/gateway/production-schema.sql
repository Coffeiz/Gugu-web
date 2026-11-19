-- 显式迁移审查；仅在隔离测试库自动执行，不在启动时修改用户库。
BEGIN;
CREATE TABLE gugu_im_runtime_bindings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 16 AND 65536),
  PRIMARY KEY(user_id,session_id,run_id)
);
COMMIT;
