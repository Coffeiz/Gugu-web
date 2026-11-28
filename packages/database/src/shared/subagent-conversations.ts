/** 子会话归属不依赖父 Run。加密执行记录仍保留原坐标。 */
export function subagentConversationSchema(randomShortId: string) {
  return `
CREATE TABLE IF NOT EXISTS agent_subagent_conversations (
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_session_id INTEGER NOT NULL UNIQUE REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  current_run_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (owner_id,parent_session_id,child_id)
);
WITH existing AS (
  SELECT d.owner_id,d.parent_session_id,d.child_id,s.child_session_id,d.child_run_id,
    row_number() OVER (
      PARTITION BY d.owner_id,d.parent_session_id,d.child_id
      ORDER BY d.updated_at,d.child_run_id
    ) AS duplicate
  FROM agent_subagent_deliveries d JOIN agent_subagent_sessions s USING (child_run_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_subagent_conversations c WHERE c.child_session_id=s.child_session_id
  )
)
INSERT INTO agent_subagent_conversations (owner_id,parent_session_id,child_id,child_session_id,current_run_id)
SELECT e.owner_id,e.parent_session_id,
  CASE WHEN e.duplicate=1 AND NOT EXISTS (
    SELECT 1 FROM agent_subagent_conversations c
    WHERE c.owner_id=e.owner_id AND c.parent_session_id=e.parent_session_id AND c.child_id=e.child_id
  ) THEN e.child_id ELSE ${randomShortId} END,
  e.child_session_id,e.child_run_id
FROM existing e WHERE true
ON CONFLICT(child_session_id) DO NOTHING;
`
}
