/** 保存父运行等待的确切子任务，供调度器在提交终态后领取。 */
export const subagentWaitSchema = `
CREATE TABLE IF NOT EXISTS agent_subagent_waits (
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  PRIMARY KEY(owner_id, parent_session_id, parent_run_id),
  FOREIGN KEY(owner_id, parent_session_id, parent_run_id, child_id)
    REFERENCES agent_subagent_deliveries(owner_id, parent_session_id, parent_run_id, child_id) ON DELETE CASCADE
);
`
