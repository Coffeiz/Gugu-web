import { definePostgresMigration } from '../runner.js'

export const projectWorkspaces = definePostgresMigration({
  revision: '0037_project_workspaces',
  prerequisites: ['projects', 'workspace_directories'],
  tables: ['project_workspace_directories'],
  sql: `
    CREATE TABLE project_workspace_directories (
      user_id uuid NOT NULL,
      project_id integer NOT NULL,
      directory_id integer NOT NULL,
      PRIMARY KEY (user_id, project_id, directory_id),
      FOREIGN KEY (project_id, user_id) REFERENCES projects (id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (directory_id, user_id) REFERENCES workspace_directories (id, user_id) ON DELETE CASCADE
    );
    CREATE INDEX project_workspace_directories_directory
      ON project_workspace_directories (directory_id, user_id);
  `,
})
