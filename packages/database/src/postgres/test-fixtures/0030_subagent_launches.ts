import { subagentLaunchSchema } from '../../shared/subagent-launches.js'
import { definePostgresMigration } from '../runner.js'

export const subagentLaunches = definePostgresMigration({
  revision: '0030_subagent_launches',
  prerequisites: ['agent_subagent_sessions'],
  tables: ['agent_subagent_launches'],
  sql: subagentLaunchSchema('bytea'),
})
