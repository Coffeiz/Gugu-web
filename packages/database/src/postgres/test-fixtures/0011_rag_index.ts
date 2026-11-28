import { tablesSql } from '../../schema.js'
import { definePostgresMigration } from '../runner.js'

const { ragIndexEntries, ragIndexIndexes } = tablesSql('postgres')
export const ragIndex = definePostgresMigration({
  revision: '0011_rag_index',
  sql: [
    ragIndexEntries.replace(' IF NOT EXISTS', ''),
    ...ragIndexIndexes.map(statement => statement.replace(' IF NOT EXISTS', '')),
    'ALTER TABLE knowledge_index_entries ADD CONSTRAINT fk_knowledge_index_owner FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE',
  ].join(';\n'),
  tables: ['knowledge_index_entries'],
  prerequisites: ['users'],
})
export const { check: checkRagIndexMigration, apply: applyRagIndexMigration } = ragIndex
export { PostgresMigrationError as RagIndexMigrationError } from '../runner.js'
