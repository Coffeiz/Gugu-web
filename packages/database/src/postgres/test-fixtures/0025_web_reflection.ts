import { definePostgresMigration } from '../runner.js'

export const webReflection = definePostgresMigration({
  revision: '0025_web_reflection',
  prerequisites: ['conversation_sessions', 'users'],
  tables: ['web_reflection_intervals'],
  downstreamFields: ['web_reflection_intervals.compaction_through'],
  sql: `
CREATE TABLE web_reflection_intervals (
  session_id integer PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observed_through bigint NOT NULL DEFAULT 0,
  completed_through bigint NOT NULL DEFAULT 0,
  pending jsonb NOT NULL DEFAULT '[]',
  frozen jsonb NOT NULL DEFAULT '[]',
  batch_limit integer NOT NULL DEFAULT 100 CHECK (batch_limit BETWEEN 1 AND 100),
  idle_due_at timestamptz NOT NULL,
  retry_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  CHECK (completed_through <= observed_through)
);
CREATE INDEX web_reflection_intervals_owner ON web_reflection_intervals(user_id);
CREATE INDEX web_reflection_intervals_due ON web_reflection_intervals(coalesce(retry_at,idle_due_at))
WHERE pending <> '[]'::jsonb OR frozen <> '[]'::jsonb;
`,
})
