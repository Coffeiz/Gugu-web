import { definePostgresMigration } from '../runner.js'

export const reflectionCompaction = definePostgresMigration({
  revision: '0026_reflection_compaction',
  prerequisites: ['web_reflection_intervals'],
  tables: [],
  trackedFields: ['web_reflection_intervals.compaction_through'],
  sql: `
ALTER TABLE web_reflection_intervals ADD COLUMN compaction_through bigint;
`,
})
