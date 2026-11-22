/** 同一个子会话可有多次执行，旧映射和密文继续按原坐标读取。 */
export function subagentContinuationSchema(binary: 'bytea' | 'BLOB') {
  return `
CREATE TABLE IF NOT EXISTS agent_subagent_continuations (
  child_run_id TEXT PRIMARY KEY,
  child_session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  nonce ${binary} NOT NULL,
  payload ${binary} NOT NULL
);
CREATE VIEW IF NOT EXISTS agent_subagent_execution_sessions AS
  SELECT child_run_id,child_session_id FROM agent_subagent_sessions
  UNION ALL SELECT child_run_id,child_session_id FROM agent_subagent_continuations;
CREATE VIEW IF NOT EXISTS agent_subagent_execution_launches AS
  SELECT child_run_id,nonce,payload FROM agent_subagent_launches
  UNION ALL SELECT child_run_id,nonce,payload FROM agent_subagent_continuations;
`
}
