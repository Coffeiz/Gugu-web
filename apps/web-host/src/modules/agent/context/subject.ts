import type { HistoryIdentity } from '@gugu/core/agent'

/** 来源类型由 Host 绑定。SQL 片段来自固定表，ID 始终作为参数绑定。 */
export function agentContextSubject(kind: 'chat' | 'scheduled_task', identity: HistoryIdentity) {
  const scheduled = kind === 'scheduled_task'
  const prefix = 'scheduled-task:'
  const id = scheduled && identity.sessionId.startsWith(prefix) ? identity.sessionId.slice(prefix.length) : identity.sessionId
  if (!identity.ownerId || (scheduled && !identity.sessionId.startsWith(prefix))
    || !/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id)))
    throw new TypeError(scheduled ? '定时任务身份无效' : '会话身份无效')
  return {
    id,
    from: scheduled ? '(SELECT id,user_id FROM scheduled_tasks WHERE enabled=TRUE)' : 'conversation_sessions',
    missing: scheduled ? '定时任务不存在' : '会话不存在',
  }
}
