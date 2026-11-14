import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ConfigDocument = Record<string, unknown>

export function resolveConfigOverridePath(env: NodeJS.ProcessEnv): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../')
  return resolve(env.GUGU_CONFIG_OVERRIDE_FILE?.trim() || `${root}/backend/config.override.json`)
}

export function readConfigOverride(path: string): ConfigDocument {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as ConfigDocument
  } catch {
    throw new Error('用户运行配置文件损坏或格式无效，已拒绝读取和覆盖')
  }
}

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = result[key]
      result[key] = merge(current && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown> : {}, value as Record<string, unknown>)
    } else result[key] = value
  }
  return result
}

export function updateConfigOverride(path: string, patch: ConfigDocument): ConfigDocument {
  const document = merge(readConfigOverride(path), patch)
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, path)
    const dirFd = openSync(directory, 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporaryPath) } catch { /* The file may already have been renamed. */ }
    throw new Error('用户运行配置保存失败')
  }
  return document
}
