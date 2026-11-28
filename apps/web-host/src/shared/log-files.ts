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
  if (!(error instanceof Error)) {
    diagLogRaw(where, inspect(error, { colors: false, customInspect: false, depth: 4, maxStringLength: 2000 }))
    return
  }
  const chain: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current) && chain.length < 4) {
    seen.add(current)
    const stack = current.stack?.split('\n').slice(1, 9).join('\n')
    chain.push(`${current.name}: ${current.message}${stack ? `\n${stack}` : ''}`)
    current = (current as Error & { cause?: unknown }).cause
  }
  if (current !== undefined && chain.length < 4 && !seen.has(current))
    chain.push(inspect(current, { colors: false, customInspect: false, depth: 2, maxStringLength: 1000 }))
  diagLogRaw(where, chain.join('\nCaused by: '))
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
