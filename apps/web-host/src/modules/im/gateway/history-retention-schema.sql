-- Node明确登记的保留目标及提交后附件回收。备份/审查后显式迁移，不自动应用。
BEGIN;
CREATE TABLE gugu_im_history_retention_targets (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 generation bigint NOT NULL CHECK(generation>0),
 completed_generation bigint NOT NULL DEFAULT 0 CHECK(completed_generation>=0),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,session_id),
 CHECK(completed_generation<=generation)
);
CREATE INDEX ix_gugu_im_retention_ready ON gugu_im_history_retention_targets(next_attempt_at) WHERE generation>completed_generation;
-- 不引用session，避免整会话删除后失去已提交但未完成的FS回收记录。
CREATE TABLE gugu_im_history_retention_storage (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 storage_key text NOT NULL,
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,storage_key)
);
COMMIT;
