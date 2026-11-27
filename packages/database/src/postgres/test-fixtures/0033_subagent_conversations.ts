import { subagentConversationSchema } from '../../shared/subagent-conversations.js'
import { definePostgresMigration } from '../runner.js'

export const subagentConversations = definePostgresMigration({
  revision: '0033_subagent_conversations',
  prerequisites: ['agent_subagent_sessions', 'agent_subagent_deliveries'],
  tables: ['agent_subagent_conversations'],
  sql: subagentConversationSchema('substr(md5(random()::text),1,8)'),
})
