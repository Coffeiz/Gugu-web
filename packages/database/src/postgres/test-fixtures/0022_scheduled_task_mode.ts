import { definePostgresMigration } from '../runner.js'

export const scheduledTaskMode = definePostgresMigration({
  revision: '0022_scheduled_task_mode',
  prerequisites: ['scheduled_tasks'],
  tables: [],
  trackedFields: ['scheduled_tasks.execution_mode', 'scheduled_tasks.scheduled_tasks_execution_mode_check'],
  sql: `
ALTER TABLE scheduled_tasks ADD COLUMN execution_mode VARCHAR(16) NOT NULL DEFAULT 'instruction',
  ADD CONSTRAINT scheduled_tasks_execution_mode_check CHECK (execution_mode IN ('reminder', 'instruction'));
`,
})
