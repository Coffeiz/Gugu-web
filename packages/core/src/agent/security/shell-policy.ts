import { classifyShellCommandRisk, type ShellCommandRisk } from './shell-command-risk.js'
import type { RunIdentity } from '../models.js'
import { actionApprovalMode, type ActionApprovalPolicy } from '../tools/confirmation.js'

export function createHostShellGrants(durationMs: number, now = Date.now) {
  const grants = new Map<string, { expiresAt: number; authorization: string }>()
  const key = ({ ownerId, sessionId }: RunIdentity) => JSON.stringify([ownerId, sessionId])
  return {
    permits(identity: RunIdentity, authorization: string) {
      const id = key(identity)
      const grant = grants.get(id)
      if (!grant) return false
      if (grant.expiresAt <= now() || grant.authorization !== authorization) {
        grants.delete(id)
        return false
      }
      return true
    },
    approve(identity: RunIdentity, authorization: string) {
      const time = now()
      for (const [id, grant] of grants) if (grant.expiresAt <= time) grants.delete(id)
      grants.set(key(identity), { expiresAt: time + durationMs, authorization })
    },
  }
}


export interface ShellPolicyFacts {
  adminEnabled: boolean
  userEnabled: boolean
  sandboxEnabled: boolean
  sandboxReady: boolean
  sandboxReason?: string
  sessionOwned: boolean
  workspaceValid: boolean
  filesystemAuthorizationAvailable: boolean
  fullUserSandboxWrite: boolean
  adminDangerousEnabled: boolean
  userDangerousEnabled: boolean
}

export interface ShellPolicyDecision {
  allowed: boolean
  reason: string
  risk: ShellCommandRisk
  needsConfirmation: boolean
  fullUserSandboxWrite: boolean
}

/** 事实由可信 Host 在每次执行时读取；此函数不授予执行权限。 */
export function evaluateSandboxShell(command: string, facts: ShellPolicyFacts, options?: { isolatedWorkspaceWrite?: boolean }): ShellPolicyDecision {
  // 仅可信 Host 验证过普通写入语法、且由执行器限制写挂载时，才能传入此标记。
  const risk = options?.isolatedWorkspaceWrite ? 'write' : classifyShellCommandRisk(command)
  const deny = (reason: string): ShellPolicyDecision => ({ allowed: false, reason, risk, needsConfirmation: false, fullUserSandboxWrite: false })
  if (!facts.adminEnabled) return deny('管理员未开启 Shell 工具')
  if (!facts.sandboxEnabled) return deny('Shell 沙盒未开启')
  if (!facts.userEnabled) return deny('用户未开启 Shell')
  if (!facts.sessionOwned) return deny('会话不存在')
  if (!facts.workspaceValid) return deny('工作区不存在或已停用')
  if (!facts.sandboxReady) return deny(facts.sandboxReason || 'Shell 沙盒不可用')
  if (!facts.filesystemAuthorizationAvailable) return deny('用户沙箱授权状态暂时不可用')
  if (risk === 'dangerous' && !facts.adminDangerousEnabled) return deny('管理员未开放全部 Shell 命令')
  if (risk === 'dangerous' && !facts.userDangerousEnabled) return deny('用户未开放全部 Shell 命令')
  return { allowed: true, reason: risk === 'dangerous' ? '危险命令需要用户确认' : '允许在 sandbox 范围执行', risk,
    needsConfirmation: risk === 'dangerous', fullUserSandboxWrite: facts.fullUserSandboxWrite }
}


export function shellConfirmationMode(
  decision: Pick<ShellPolicyDecision, 'risk' | 'needsConfirmation'>,
  options: { system: boolean; isolatedWorkspace: boolean; approvalPolicy: ActionApprovalPolicy; hasResolution: boolean },
): 'request' | 'verify' | 'execute' | 'stale' {
  const required = !options.isolatedWorkspace && (decision.needsConfirmation || (!options.system && decision.risk === 'write'))
  return actionApprovalMode(options.approvalPolicy, required, options.hasResolution)
}
