import { definePostgresMigration } from '../runner.js'

export const projectUndoPaths = definePostgresMigration({
  revision: '0040_project_undo_paths',
  prerequisites: ['project_undo_journals'],
  tables: [],
  sql: `
    UPDATE project_undo_journals journal
    SET moves = COALESCE((
      SELECT json_agg(move.value - 'fileId' ORDER BY move.ordinality)
      FROM jsonb_array_elements(journal.moves::jsonb) WITH ORDINALITY AS move(value, ordinality)
    ), '[]'::json);
  `,
})
