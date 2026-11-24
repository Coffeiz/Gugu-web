import { definePostgresMigration } from '../runner.js'

export const scheduledTaskFilePaths = definePostgresMigration({
  revision: '0039_scheduled_task_file_paths',
  prerequisites: ['scheduled_tasks', 'files'],
  tables: [],
  trackedFields: ['scheduled_tasks.email_attachment_file_paths'],
  downstreamFields: ['scheduled_tasks.email_attachment_file_ids'],
  sql: `
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='scheduled_tasks' AND column_name='email_attachment_file_ids') THEN
        EXECUTE $legacy$
          DO $convert$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM scheduled_tasks task
              CROSS JOIN LATERAL json_array_elements_text(task.email_attachment_file_ids::json) item(file_id)
              LEFT JOIN files file ON file.id=item.file_id::integer AND file.user_id=task.user_id AND file.deleted_at IS NULL
              WHERE file.id IS NULL OR split_part(file.storage_key,'/',2) NOT IN ('个人文件','项目文件','workspace')
                OR file.storage_key !~ ('^' || task.user_id::text || '/(个人文件|项目文件|workspace)/.+$')
            ) THEN RAISE EXCEPTION '定时任务附件无法转换为文件路径'; END IF;
          END $convert$;

          ALTER TABLE scheduled_tasks ADD COLUMN email_attachment_file_paths json NOT NULL DEFAULT '[]';
          UPDATE scheduled_tasks task SET email_attachment_file_paths = COALESCE((
            SELECT json_agg(CASE split_part(file.storage_key,'/',2)
              WHEN '个人文件' THEN '/personal/' || substring(file.storage_key FROM length(task.user_id::text || '/个人文件/')+1)
              WHEN '项目文件' THEN '/project/' || substring(file.storage_key FROM length(task.user_id::text || '/项目文件/')+1)
              WHEN 'workspace' THEN '/workspace/' || substring(file.storage_key FROM length(task.user_id::text || '/workspace/')+1)
              ELSE NULL END ORDER BY item.ordinality)
            FROM json_array_elements_text(task.email_attachment_file_ids::json) WITH ORDINALITY item(file_id, ordinality)
            JOIN files file ON file.id=item.file_id::integer AND file.user_id=task.user_id
          ), '[]'::json);
          ALTER TABLE scheduled_tasks DROP COLUMN email_attachment_file_ids;
        $legacy$;
      END IF;
    END $migration$;
  `,
})
