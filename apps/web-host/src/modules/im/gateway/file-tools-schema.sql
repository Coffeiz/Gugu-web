-- Node文件工具独立收据，不争用包围Runner的投递锁；审查后显式执行。
BEGIN;
CREATE TABLE gugu_im_file_tool_receipts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 run_id varchar(128) NOT NULL,
 artifact_hash char(64) NOT NULL,
 state varchar(12) NOT NULL CHECK(state IN ('pending','sent','failed','unknown')),
 attempt_id uuid NOT NULL,
 PRIMARY KEY(user_id,session_id,run_id,artifact_hash)
);
COMMIT;
