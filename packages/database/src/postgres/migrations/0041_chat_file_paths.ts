import { definePostgresMigration } from '../runner.js'

export const chatFilePaths = definePostgresMigration({
  revision: '0041_chat_file_paths',
  prerequisites: ['conversation_messages', 'conversation_sessions', 'files'],
  tables: [],
  sql: `
    UPDATE conversation_messages message
       SET files = (
         SELECT jsonb_agg(
           CASE WHEN jsonb_typeof(item.value->'file_id') = 'number' THEN
             COALESCE((
               SELECT (item.value - 'file_id') || jsonb_build_object('file_path', CASE split_part(file.storage_key,'/',2)
                 WHEN '个人文件' THEN '/personal/' || substring(file.storage_key FROM length(session.user_id::text || '/个人文件/')+1)
                 WHEN '项目文件' THEN '/project/' || substring(file.storage_key FROM length(session.user_id::text || '/项目文件/')+1)
                 WHEN 'workspace' THEN '/workspace/' || substring(file.storage_key FROM length(session.user_id::text || '/workspace/')+1)
               END)
                 FROM files file
                WHERE file.id = CASE WHEN item.value->>'file_id' ~ '^[1-9][0-9]{0,9}$'
                                     THEN (item.value->>'file_id')::integer END
                  AND file.user_id = session.user_id
                  AND file.deleted_at IS NULL
                  AND file.storage_key ~ ('^' || session.user_id::text || '/(个人文件|项目文件|workspace)/.+$')
             ), (item.value - 'file_id') || '{"unavailable":true}'::jsonb)
             ELSE item.value
           END ORDER BY item.ordinality
         )
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(message.files) = 'array' THEN message.files ELSE '[]'::jsonb END)
             WITH ORDINALITY item(value, ordinality)
       )
      FROM conversation_sessions session
     WHERE session.id = message.session_id
       AND jsonb_typeof(message.files) = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(message.files) = 'array' THEN message.files ELSE '[]'::jsonb END) item(value)
          WHERE jsonb_typeof(item.value->'file_id') = 'number'
       );
  `,
})
