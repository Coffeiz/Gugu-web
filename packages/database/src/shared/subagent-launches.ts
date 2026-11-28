/** 子运行恢复输入随派单一起提交，正文和模型身份存入认证密文。 */
export function subagentLaunchSchema(binary: 'bytea' | 'BLOB') {
  return `
CREATE TABLE IF NOT EXISTS agent_subagent_launches (
  child_run_id TEXT PRIMARY KEY REFERENCES agent_subagent_sessions(child_run_id) ON DELETE CASCADE,
  nonce ${binary} NOT NULL,
  payload ${binary} NOT NULL
);
`
}
