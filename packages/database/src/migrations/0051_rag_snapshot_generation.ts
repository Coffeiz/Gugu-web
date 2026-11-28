import { CompiledQuery } from 'kysely'
import type { LogicalMigration } from './plan.js'

const trigger = (statement: string) => ({ compile: () => CompiledQuery.raw(statement) })

const advance = (owner: 'OLD' | 'NEW') => `
  INSERT INTO rag_snapshot_generations(owner_user_id, generation) VALUES (${owner}.owner_user_id, 1)
  ON CONFLICT(owner_user_id) DO UPDATE SET generation=generation+1;
`

export const ragSnapshotGeneration = {
  id: '0051_rag_snapshot_generation',
  targets: ['sqlite'],
  prerequisites: ['knowledge_index_entries'],
  tables: ['rag_snapshot_generations'],
  triggers: ['rag_snapshot_insert', 'rag_snapshot_update', 'rag_snapshot_delete', 'rag_snapshot_owner_update'],
  build: db => [
    db.schema.createTable('rag_snapshot_generations')
      .addColumn('owner_user_id', 'text', col => col.primaryKey().notNull())
      .addColumn('generation', 'integer', col => col.notNull()),
    trigger(`CREATE TRIGGER rag_snapshot_insert AFTER INSERT ON knowledge_index_entries BEGIN ${advance('NEW')} END`),
    trigger(`CREATE TRIGGER rag_snapshot_update AFTER UPDATE ON knowledge_index_entries BEGIN ${advance('NEW')} END`),
    trigger(`CREATE TRIGGER rag_snapshot_delete AFTER DELETE ON knowledge_index_entries BEGIN ${advance('OLD')} END`),
    trigger(`CREATE TRIGGER rag_snapshot_owner_update AFTER UPDATE OF owner_user_id ON knowledge_index_entries
      WHEN OLD.owner_user_id <> NEW.owner_user_id BEGIN ${advance('OLD')} END`),
  ],
} as const satisfies LogicalMigration
