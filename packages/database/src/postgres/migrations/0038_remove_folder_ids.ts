import { definePostgresMigration } from '../runner.js'

export const removeFolderIds = definePostgresMigration({
  revision: '0038_remove_folder_ids',
  prerequisites: ['users', 'files', 'workspaces', 'project_file_counts'],
  tables: [],
  createdObjects: [],
  absentTables: ['folders'],
  absentFields: ['files.folder_id', 'workspaces.folder_id'],
  sql: `
    CREATE OR REPLACE FUNCTION gugu_project_file_counts_changed() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        PERFORM gugu_apply_project_file_delta(project_id,count(*))
        FROM new_files WHERE space='project' AND project_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY project_id ORDER BY project_id;
      ELSIF TG_OP='DELETE' THEN
        PERFORM gugu_apply_project_file_delta(project_id,-count(*))
        FROM old_files WHERE space='project' AND project_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY project_id ORDER BY project_id;
      ELSE
        PERFORM gugu_apply_project_file_delta(project_id,sum(delta)::bigint)
        FROM (
          SELECT project_id,count(*) AS delta FROM new_files
            WHERE space='project' AND project_id IS NOT NULL AND deleted_at IS NULL GROUP BY project_id
          UNION ALL
          SELECT project_id,-count(*) AS delta FROM old_files
            WHERE space='project' AND project_id IS NOT NULL AND deleted_at IS NULL GROUP BY project_id
        ) AS differences GROUP BY project_id HAVING sum(delta)<>0 ORDER BY project_id;
      END IF;
      RETURN NULL;
    END;
    $$;

    TRUNCATE project_file_counts;
    INSERT INTO project_file_counts(project_id,file_count)
      SELECT project_id,count(*) FROM files
      WHERE space='project' AND project_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY project_id;

    DELETE FROM workspaces WHERE kind='folder' OR folder_id IS NOT NULL;
    DROP INDEX gugu_files_owner_folder;
    ALTER TABLE files DROP COLUMN folder_id;
    ALTER TABLE workspaces DROP COLUMN folder_id;
    DROP TABLE folders;

    ALTER TABLE users DROP COLUMN storage_limit_bytes;
    DROP TABLE storage_quota_events;
    DROP TABLE storage_quota_ledgers;
  `,
})
