import { appendFile } from 'node:fs/promises'
import { AgentRunError, type RunIdentity } from '@gugu/core/agent'

/** 管理日志只保留阶段、故障分类和 Run 指纹。 */
export function createWebAgentFailureLogger(logFile: string | null, fingerprint: (value: string) => string) {
  return (code: string, failure?: { identity: RunIdentity; phase: string; error: unknown }): void | Promise<void> => {
    if (code !== 'run_failed' || !failure) {
      console.error('Web Agent 运行端口失败', code)
      return
    }
    const { identity, phase, error } = failure
    const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : null
    const errorCode = error instanceof AgentRunError ? error.code
      : typeof rawCode === 'string' && /^[A-Z0-9]{5}$/.test(rawCode) ? rawCode
        : 'internal_error'
    const time = new Date().toISOString().slice(5, 19).replace('T', ' ')
    const run = fingerprint(JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])).slice(0, 16)
    const line = `${time} [error] Web Agent 生成失败 phase=${phase} code=${errorCode} run=${run}`
    if (!logFile) { console.error(line); return }
    return appendFile(logFile, `${line}\n`, { mode: 0o600 }).catch(() => console.error(line))
  }
}
