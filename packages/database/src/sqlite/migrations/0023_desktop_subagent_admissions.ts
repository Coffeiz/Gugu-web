import type SQLite from 'better-sqlite3'

/** 将升级前尚未交付的子 Run 登记到普通恢复入口，保留已有执行 ID 和 checkpoint。 */
export function initializeDesktopSubagentAdmissions(db: SQLite.Database): void {
  db.transaction(() => {
    const candidates = db.prepare(`
      SELECT s.user_id, s.id AS session_id, e.child_run_id AS run_id,
        max(s.last_message_seq, coalesce((SELECT max(m.conversation_seq)
          FROM conversation_messages m WHERE m.session_id=s.id), 0))+1 AS sequence
      FROM agent_subagent_conversations c
      JOIN agent_subagent_executions e ON e.child_run_id=c.current_run_id AND e.child_session_id=c.child_session_id
      JOIN agent_subagent_deliveries d ON d.child_run_id=e.child_run_id AND d.owner_id=c.owner_id
        AND d.parent_session_id=c.parent_session_id AND d.child_id=c.child_id
      JOIN conversation_sessions s ON s.id=e.child_session_id AND s.user_id=replace(c.owner_id,'-','')
      WHERE s.source='subagent' AND d.status IN ('queued','running') AND e.payload IS NOT NULL
        AND (s.active_run_id IS NULL OR s.active_run_id=e.child_run_id)
        AND NOT EXISTS (SELECT 1 FROM agent_run_admissions a
          WHERE a.user_id=s.user_id AND a.session_id=s.id AND a.run_id=e.child_run_id)
    `).all() as Array<{ user_id: string; session_id: number; run_id: string; sequence: number }>
    const insertMessage = db.prepare(`
      INSERT INTO conversation_messages (session_id,conversation_seq,role,content,created_at)
      VALUES (@session_id,@sequence,'user','子 Agent 委派',@timestamp)
    `)
    const insertAdmission = db.prepare(`
      INSERT INTO agent_run_admissions (user_id,session_id,run_id,user_message_id)
      VALUES (@user_id,@session_id,@run_id,@message_id)
    `)
    const activateSession = db.prepare(`
      UPDATE conversation_sessions SET active_run_id=@run_id,execution_state='running',last_message_seq=@sequence
      WHERE id=@session_id AND user_id=@user_id
    `)
    const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '000')
    for (const run of candidates) {
      const message = insertMessage.run({ ...run, timestamp })
      insertAdmission.run({ ...run, message_id: message.lastInsertRowid })
      activateSession.run(run)
    }
  }).immediate()
}
