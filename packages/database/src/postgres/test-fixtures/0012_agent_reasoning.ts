import { definePostgresMigration } from '../runner.js'

export const agentReasoningSql = {
  agentReasoningActive: `
CREATE TABLE gugu_agent_active_reasoning (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  checkpoint_version bigint NOT NULL CHECK(checkpoint_version>=0),
  ref_hash varchar(64) NOT NULL,
  context_hash varchar(64) NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 16 AND 16777232),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,session_id,run_id),
  FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_checkpoints(user_id,session_id,run_id) ON DELETE CASCADE
);
`,
} as const

export const agentReasoning = definePostgresMigration({
  revision: '0012_agent_reasoning',
  sql: Object.values(agentReasoningSql).join('\n'),
  tables: [
    'gugu_agent_active_reasoning',
  ],
  prerequisites: ['agent_run_checkpoints'],
})
