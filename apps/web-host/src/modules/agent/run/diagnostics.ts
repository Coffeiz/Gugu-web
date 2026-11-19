import { dirname, join } from 'node:path'
import { createAgentLog } from '@gugu/log'
import { appendDiagnosticLine, createLogWriter } from '../../../shared/log-files.js'

/** Agent 运行周边的固定错误文案统一带 ISO 时间；动态字段只接受安全诊断码。 */
export function writeTimestampedAgentDiagnostic(message: string, code?: string): void {
  const safeCode = code && /^[a-z][a-z0-9_.-]{0,63}$/i.test(code) ? ` code=${code}` : ''
  console.error(`${new Date().toISOString()} [error] ${message}${safeCode}`)
}

export function createWebAgentLog(logFile: string | null, fingerprint: (value: string) => string) {
  const append = logFile ? createLogWriter(logFile) : null
  return createAgentLog({
    regular(line) {
      if (append) {
        try { append(line); return }
        catch { /* 控制台仍提供脱敏摘要。 */ }
      }
      console.info(line.trimEnd())
    },
    diagnostic: logFile ? createLogWriter(join(dirname(logFile), 'gugu-diag.log')) : appendDiagnosticLine,
    fingerprint,
  })
}
