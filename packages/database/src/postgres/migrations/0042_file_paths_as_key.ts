import { definePostgresMigration } from '../runner.js'

export const filePathsAsKey = definePostgresMigration({
  revision: '0042_file_paths_as_key',
  prerequisites: ['files'],
  tables: ['files'],
  createdObjects: [],
  trackedFields: ['files.files_pkey'],
  downstreamFields: ['files.id', 'files.files_pkey'],
  absentFields: ['files.id'],
  downstreamRemovedBy: '0043_files_path_column',
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM files GROUP BY user_id,storage_key HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION '文件路径存在重复记录，不能移除文件行号';
      END IF;
    END $$;

    ALTER TABLE files DROP CONSTRAINT files_pkey;
    ALTER TABLE files DROP COLUMN id;
    ALTER TABLE files ADD CONSTRAINT files_pkey PRIMARY KEY (user_id,storage_key);
    DROP INDEX uq_files_active_user_storage_key;
  `,
})
