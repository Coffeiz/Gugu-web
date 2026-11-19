-- 仅用于已经手工应用旧Node反思schema的数据库；先备份并审查，再显式执行。
-- 全新库直接应用当前reflection-schema.sql，不执行本升级；入口禁止自动DDL。
BEGIN;
ALTER TABLE gugu_im_reflection_jobs ADD COLUMN IF NOT EXISTS window_key varchar(128) NOT NULL DEFAULT 'run';
-- 旧Run缺少启动时scope证明，保持NULL，不得用升级时当前版本回填授权。
ALTER TABLE gugu_im_reflection_run_revisions ADD COLUMN IF NOT EXISTS scope_versions jsonb;
DO $$
DECLARE previous_key text;
BEGIN
  SELECT c.conname INTO previous_key FROM pg_constraint c
  WHERE c.conrelid='gugu_im_reflection_jobs'::regclass AND c.contype='u'
    AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n)
      =ARRAY['user_id','session_id','run_id','scope_hash'];
  IF previous_key IS NOT NULL THEN
    EXECUTE format('ALTER TABLE gugu_im_reflection_jobs DROP CONSTRAINT %I',previous_key);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='gugu_im_reflection_jobs'::regclass AND c.contype='u'
    AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n)
      =ARRAY['user_id','session_id','run_id','scope_hash','window_key']) THEN
    ALTER TABLE gugu_im_reflection_jobs ADD CONSTRAINT gugu_im_reflection_job_window_unique
      UNIQUE(user_id,session_id,run_id,scope_hash,window_key);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS gugu_im_reflection_cursor_positions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  scope_hash varchar(64) NOT NULL,
  scope_version integer NOT NULL CHECK(scope_version>=0),
  last_sequence bigint NOT NULL CHECK(last_sequence>0),
  last_message_id integer NOT NULL,
  PRIMARY KEY(user_id,session_id,scope_hash,scope_version)
);
-- 若曾应用开发期触发表，缺原scope快照的窗口只能取消；空对象只用于归档，不重新激活。
DO $$
BEGIN
  IF to_regclass('gugu_im_reflection_trigger_states') IS NOT NULL THEN
    ALTER TABLE gugu_im_reflection_trigger_states ADD COLUMN IF NOT EXISTS observe_after timestamptz NOT NULL DEFAULT clock_timestamp();
  END IF;
  IF to_regclass('gugu_im_reflection_trigger_windows') IS NOT NULL THEN
    ALTER TABLE gugu_im_reflection_trigger_windows ADD COLUMN IF NOT EXISTS scope_versions jsonb;
    UPDATE gugu_im_reflection_trigger_windows SET status='cancelled',completed_at=clock_timestamp()
      WHERE scope_versions IS NULL AND status='pending';
    UPDATE gugu_im_reflection_trigger_windows SET scope_versions='{}'::jsonb WHERE scope_versions IS NULL;
    ALTER TABLE gugu_im_reflection_trigger_windows ALTER COLUMN scope_versions SET NOT NULL;
  END IF;
END $$;
COMMIT;
