/** 一次性合并旧派单与续聊执行，密文原样搬迁。 */
export function subagentExecutionMigration(binary: 'bytea' | 'BLOB') {
  return `
CREATE TABLE IF NOT EXISTS agent_subagent_executions (
  child_run_id TEXT PRIMARY KEY,
  child_session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  nonce ${binary},
  payload ${binary},
  CHECK ((nonce IS NULL AND payload IS NULL) OR (nonce IS NOT NULL AND payload IS NOT NULL))
);
INSERT INTO agent_subagent_executions (child_run_id,child_session_id,nonce,payload)
SELECT s.child_run_id,s.child_session_id,l.nonce,l.payload
FROM agent_subagent_sessions s
LEFT JOIN agent_subagent_launches l USING(child_run_id)
UNION ALL
SELECT child_run_id,child_session_id,nonce,payload FROM agent_subagent_continuations;
DELETE FROM agent_subagent_launches;
DELETE FROM agent_subagent_sessions;
DELETE FROM agent_subagent_continuations;
`
}
