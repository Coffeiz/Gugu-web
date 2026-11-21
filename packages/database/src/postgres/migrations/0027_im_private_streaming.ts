import { definePostgresMigration } from '../runner.js'

export const imPrivateStreaming = definePostgresMigration({
  revision: '0027_im_private_streaming',
  prerequisites: ['user_bots'],
  tables: [],
  trackedFields: ['user_bots.private_streaming_enabled'],
  sql: `
UPDATE user_bots SET private_streaming_enabled=TRUE WHERE platform IN ('feishu','telegram');
ALTER TABLE user_bots ALTER COLUMN private_streaming_enabled SET DEFAULT TRUE;
`,
})
