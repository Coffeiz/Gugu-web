import { closeSync, chmodSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
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

export interface ConfigOverrideLock {
  withExclusive<T>(path: string, work: () => Promise<T>): Promise<T>
}

/** 与 Python _override_file_lock 使用同一锁文件，锁覆盖完整读改写。 */
export async function updateConfigOverride(path: string, patch: ConfigDocument, lock: ConfigOverrideLock): Promise<ConfigDocument> {
  if (!lock || typeof lock.withExclusive !== 'function') throw new Error('配置跨进程锁不可用')
  return lock.withExclusive(join(dirname(path), `.${basename(path)}.lock`), async () => {
    if (!existsSync(path)) throw new Error('用户运行配置不存在，拒绝创建')
    return writeConfigOverrideLocked(path, patch)
  })
}

function writeConfigOverrideLocked(path: string, patch: ConfigDocument, replaceDocument = false): ConfigDocument {
  const document = replaceDocument ? patch : merge(readConfigOverride(path), patch)
  const directory = dirname(path)
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

/** 数组资源的读、业务校验与原子发布共用Python同一把锁，拒绝缺失/损坏文件。 */
export async function mutateConfigOverride<T>(path:string,mutate:(document:ConfigDocument)=>T,lock:ConfigOverrideLock):Promise<T> {
  if(!lock || typeof lock.withExclusive!=='function')throw new Error('配置跨进程锁不可用')
  return lock.withExclusive(join(dirname(path),`.${basename(path)}.lock`),async()=>{
    if(!existsSync(path))throw new Error('用户运行配置不存在，拒绝创建')
    const document=readConfigOverride(path),result=mutate(document)
    writeConfigOverrideLocked(path,document,true)
    return result
  })
}
