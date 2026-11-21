import { createRuntimeLog } from '@gugu/log/runtime'
import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createAgentLog } from '@gugu/log'
import { createLogWriter } from '@gugu/log/file'
import { diagnosticLogPolicy, regularLogPolicy } from './policy.js'

export function desktopLogSinks(userData: string) {
  const directory = join(userData, 'logs')
  return {
    regular: createLogWriter(join(directory, 'gugu.log'), regularLogPolicy),
    diagnostic: createLogWriter(join(directory, 'gugu-diag.log'), diagnosticLogPolicy),
  }
}

export function createDesktopRuntimeLog(userData: string) {
  return createRuntimeLog(desktopLogSinks(userData))
}

/** 本地 Agent Run 由主进程管理落盘，renderer 与 Core RPC 的标准输出不参与写文件。 */
export function createDesktopAgentLog(userData: string) {
  const key = randomBytes(32)
  return createAgentLog({
    ...desktopLogSinks(userData),
    fingerprint: value => createHmac('sha256', key).update(value).digest('hex'),
  })
}
