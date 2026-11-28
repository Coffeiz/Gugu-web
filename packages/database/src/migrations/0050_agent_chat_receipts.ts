import type { LogicalMigration } from './plan.js'

export const agentChatReceipts = {
  id: '0050_agent_chat_receipts',
  targets: ['postgres', 'sqlite'],
  prerequisites: ['conversation_messages', 'conversation_sessions'],
  tables: ['agent_chat_receipts'],
  build: db => [db.schema.createTable('agent_chat_receipts')
    .addColumn('owner_key', 'text', col => col.notNull())
    .addColumn('session_scope', 'integer', col => col.notNull())
    .addColumn('client_id', 'text', col => col.notNull())
    .addColumn('fingerprint', 'text', col => col.notNull())
    .addColumn('session_id', 'integer', col => col.notNull().references('conversation_sessions.id').onDelete('cascade'))
    .addColumn('message_id', 'integer', col => col.notNull().references('conversation_messages.id').onDelete('cascade'))
    .addColumn('run_id', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('pk_agent_chat_receipts', ['owner_key', 'session_scope', 'client_id'])],
} as const satisfies LogicalMigration
