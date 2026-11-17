import { targetConfirmationIdentity } from '../../domains/agent-sessions/tools/confirmation-identity.js'

export interface TerminalConfirmationStore {
  redeem(owner: string, code: string): Promise<boolean>
  consumeGrant(owner: string, summary: string, identity: string): Promise<boolean | null>
  createPending(owner: string, summary: string, identity: string, ttlMinutes: number): Promise<string | null>
}

/** 确认绑定命令和可信会话上下文，授权每次仅能消费一次。 */
export function createTerminalConfirmationGate(store: TerminalConfirmationStore) {
  return async (owner: string, input: { command: string; sessionId: number | null; workspaceId: number | null; cwd: string; confirmCode?: string }) => {
    if (input.confirmCode && !await store.redeem(owner, input.confirmCode)) return { allowed: false as const, error: '确认码无效或已过期，请重新执行命令。' }
    const command = input.command.trim()
    const summary = `将在 sandbox 范围执行危险命令：${command}`
    const identity = targetConfirmationIdentity('shell.execute', { command: [command] }, {
      session_id: input.sessionId, scope: 'sandbox', workspace_id: input.workspaceId, cwd: input.cwd || '.', subject_type: 'session', subject_id: null,
    })
    const consumed = await store.consumeGrant(owner, summary, identity)
    if (consumed) return { allowed: true as const }
    const code = consumed === false ? await store.createPending(owner, summary, identity, 5) : null
    return { allowed: false as const, error: JSON.stringify({ status: code ? 'waiting_confirmation' : 'confirmation_unavailable', needs_confirm: true, summary,
      instruction: '请转达本次命令的影响并等待用户确认；授权仅用于本次执行，不覆盖后续命令。',
      ...(code ? { confirm_code: code } : { error: '确认服务暂不可用，请稍后重试。' }) }) }
  }
}
