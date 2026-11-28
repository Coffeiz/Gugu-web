import type { LogicalMigration } from './plan.js'

/** 会话列表按角色聚合最新消息，使用会话、角色和序号组成的索引。 */
export const conversationRoleSequenceIndex = 'gugu_message_session_role_sequence'

export const conversationRoleSequence = {
  id: '0049_conversation_role_sequence',
  targets: ['postgres', 'sqlite'],
  prerequisites: ['conversation_messages'],
  indexes: [conversationRoleSequenceIndex],
  build: db => [db.schema.createIndex(conversationRoleSequenceIndex)
    .on('conversation_messages').columns(['session_id', 'role', 'conversation_seq'])],
} as const satisfies LogicalMigration
