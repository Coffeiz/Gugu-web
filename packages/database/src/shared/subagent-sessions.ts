/** 将派单生成的 UUID 绑定到具有普通 Run 租约的内部会话。 */
export const subagentSessionSchema = `
CREATE TABLE IF NOT EXISTS agent_subagent_sessions (
  child_run_id TEXT PRIMARY KEY,
  child_session_id INTEGER NOT NULL UNIQUE REFERENCES conversation_sessions(id) ON DELETE CASCADE
);
`
