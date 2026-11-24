import { definePostgresMigration } from '../runner.js'

export const filesPathColumn = definePostgresMigration({
  revision: '0043_files_path_column',
  prerequisites: ['files', 'undo_operations'],
  tables: ['files', 'undo_operations'],
  createdObjects: [],
  trackedFields: ['files.path'],
  downstreamFields: ['files.storage_key'],
  absentFields: ['files.storage_key'],
  sql: `
    ALTER TABLE files RENAME COLUMN storage_key TO path;

    UPDATE undo_operations AS operation
    SET before_state = jsonb_set(
      operation.before_state::jsonb,
      '{items}',
      COALESCE((
        SELECT jsonb_object_agg(item.key,
          CASE WHEN item.value ? 'storage_key'
            THEN (item.value - 'storage_key') || jsonb_build_object('path', item.value->'storage_key')
            ELSE item.value
          END)
        FROM jsonb_each(COALESCE(operation.before_state::jsonb->'items', '{}'::jsonb)) AS item
      ), '{}'::jsonb),
      true
    )::json
    WHERE operation.before_state::jsonb ? 'items';

    UPDATE undo_operations AS operation
    SET after_state = jsonb_set(
      operation.after_state::jsonb,
      '{items}',
      COALESCE((
        SELECT jsonb_object_agg(item.key,
          CASE WHEN item.value ? 'storage_key'
            THEN (item.value - 'storage_key') || jsonb_build_object('path', item.value->'storage_key')
            ELSE item.value
          END)
        FROM jsonb_each(COALESCE(operation.after_state::jsonb->'items', '{}'::jsonb)) AS item
      ), '{}'::jsonb),
      true
    )::json
    WHERE operation.after_state::jsonb ? 'items';
  `,
})
