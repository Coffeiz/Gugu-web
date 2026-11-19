import { createRuntimeLog } from '@gugu/log/runtime'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { createLogWriter as fileWriter } from '@gugu/log/file'

const defaultLogDirectory = fileURLToPath(new URL('../../logs/', import.meta.url))

export function webLogFile(configured?: string | null): string {
  return configured?.trim() ? resolve(configured.trim()) : join(defaultLogDirectory, 'gugu.log')
}

export function createLogWriter(path: string, maxBytes = 10 * 1024 * 1024, backups = 10) {
  return fileWriter(path, { maxBytes, backups })
}

let writeDiagnostic: ReturnType<typeof createLogWriter> | undefined

export function configureDiagnosticLog(webPath: string): void {
  writeDiagnostic = createLogWriter(join(dirname(webPath), 'gugu-diag.log'))
}

export function diagLog(where: string, error: unknown): void {
  diagLogRaw(where, error instanceof Error ? error.stack ?? error.message : inspect(error, { colors: false, customInspect: false }))
}

export function appendDiagnosticLine(line: string): void {
  try { writeDiagnostic?.(line) }
  catch { /* 原始诊断只写私有日志。 */ }
}

export function diagLogRaw(where: string, message: string): void {
  appendDiagnosticLine(`${new Date().toISOString()} [gugu.diag] ${where} | ${message}\n`)
}

export function createWebRuntimeLog(configured: string | null, source: 'web' | 'gateway' = 'web') {
  const directory = dirname(webLogFile(configured))
  const file = source === 'gateway' ? join(directory, 'gugu-gateway.log') : webLogFile(configured)
  return createRuntimeLog({
    regular: configured ? createLogWriter(file) : line => console.info(line.trimEnd()),
    diagnostic: configured ? createLogWriter(join(directory, 'gugu-diag.log')) : appendDiagnosticLine,
  })
}
