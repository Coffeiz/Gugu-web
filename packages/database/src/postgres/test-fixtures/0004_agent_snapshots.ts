import { definePostgresMigration } from '../runner.js'

export const agentSnapshots = definePostgresMigration({
  revision: '0004_agent_snapshots',
  sql: `
CREATE TABLE gugu_agent_snapshot_manifest (
  user_id uuid NOT NULL, session_id integer NOT NULL, run_id varchar(128) NOT NULL, message_id integer NOT NULL,
  codec_version integer NOT NULL, key_version integer NOT NULL, wrapped_key bytea NOT NULL,
  chunk_count bigint NOT NULL CHECK (chunk_count >= 0), total_bytes bigint NOT NULL CHECK (total_bytes >= 0),
  digest bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id,session_id,run_id,message_id),
  CONSTRAINT gugu_snapshot_manifest_dispatch_fk FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_dispatch(user_id,session_id,run_id) ON DELETE CASCADE
);
CREATE TABLE gugu_agent_snapshot_chunks (
  user_id uuid NOT NULL, session_id integer NOT NULL, run_id varchar(128) NOT NULL, message_id integer NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal >= 0), nonce bytea NOT NULL, ciphertext bytea NOT NULL,
  PRIMARY KEY(user_id,session_id,run_id,message_id,ordinal),
  CONSTRAINT gugu_snapshot_chunks_manifest_fk FOREIGN KEY(user_id,session_id,run_id,message_id) REFERENCES gugu_agent_snapshot_manifest(user_id,session_id,run_id,message_id) ON DELETE CASCADE
);
`,
  tables: ['gugu_agent_snapshot_manifest', 'gugu_agent_snapshot_chunks'],
})
export const { check: checkAgentSnapshotMigration, apply: applyAgentSnapshotMigration } = agentSnapshots
