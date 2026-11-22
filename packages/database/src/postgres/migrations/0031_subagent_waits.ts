import { subagentWaitSchema } from '../../shared/subagent-waits.js'
import { definePostgresMigration } from '../runner.js'

export const subagentWaits = definePostgresMigration({
  revision: '0031_subagent_waits',
  prerequisites: ['agent_subagent_deliveries'],
  tables: ['agent_subagent_waits'],
  sql: subagentWaitSchema,
})
