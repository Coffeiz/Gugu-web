import { subagentDeliverySchema } from '../../shared/subagent-deliveries.js'
import { definePostgresMigration } from '../runner.js'

export const subagentDeliveries = definePostgresMigration({
  revision: '0028_subagent_deliveries',
  prerequisites: ['agent_run_checkpoints'],
  tables: ['agent_subagent_deliveries'],
  downstreamIndexes: ['agent_subagent_session_unread'],
  sql: subagentDeliverySchema('bytea'),
})
