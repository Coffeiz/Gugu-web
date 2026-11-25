import { definePostgresMigration } from '../runner.js'

export const activeProjectWorkspace = definePostgresMigration({
  revision: '0044_active_project_workspace',
  prerequisites: ['project_workspace_directories'],
  tables: [],
  sql: `
    ALTER TABLE project_workspace_directories ADD COLUMN active boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX project_workspace_one_active
      ON project_workspace_directories (user_id, project_id) WHERE active;
  `,
})
