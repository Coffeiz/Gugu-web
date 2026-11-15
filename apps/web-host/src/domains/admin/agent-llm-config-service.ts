import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { listProviderModels, type ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { stableJson } from '@gugu/core/agent'
import { readConfigOverride, type ConfigDocument } from '../../adapters/config-override-file.js'
import type { AdminLlmPresetOptions } from './admin-llm-presets.js'

/**
 * Host 必须使用 Python 同一配置路径旁的 .<文件名>.lock，持有 POSIX flock 独占锁直到回调返回。
 * 锁需覆盖读取、修改与原子发布；锁能力不可用时必须抛错，不能退化为进程内锁或其他锁文件。
 */
export interface ConfigFileLock {
  exclusive<T>(lockPath: string, work: () => T): T
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function initialize(document: ConfigDocument): void {
  if ('ai_presets' in document) {
    const value = document.ai_presets
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).items))
      throw new Error('LLM 预设配置无效')
    return
  }
  const ai = object(document.ai), provider = ai.provider ?? 'openai'
  document.ai_presets = { active_id: 'default', items: [{ id: 'default', name: String(provider), provider,
    api_key: ai.api_key ?? '', base_url: ai.base_url ?? '', model: ai.model ?? '', thinking: ai.thinking ?? 'disabled',
    reasoning_persistence: ai.reasoning_persistence ?? 'off', ollama_mode: ai.ollama_mode ?? 'local' }] }
}
function writeAtomic(path: string, document: ConfigDocument): void {
  const directory = dirname(path), temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, path)
    const dir = openSync(directory, 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  } catch {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* 临时文件可能已发布。 */ }
    throw new Error('用户运行配置保存失败')
  }
}

/** 只在显式注入的跨进程锁内更新预设和 ai，其他配置段保持读取时的原值。 */
export function createAgentLlmConfigService(path: string, lock: ConfigFileLock, options: { allowCreate?: boolean } = {}): Pick<AdminLlmPresetOptions, 'read' | 'mutate'> {
  if (!path || !lock || typeof lock.exclusive !== 'function') throw new Error('缺少配置文件跨进程锁')
  const lockPath = join(dirname(path), `.${basename(path)}.lock`)
  return {
    read() {
      const document = readConfigOverride(path)
      initialize(document)
      return document as ReturnType<AdminLlmPresetOptions['read']>
    },
    mutate<T>(change: (draft: ReturnType<AdminLlmPresetOptions['read']>) => T): T {
      return lock.exclusive(lockPath, () => {
        if (!existsSync(path) && options.allowCreate !== true) throw new Error('用户运行配置不存在，拒绝创建')
        const document = readConfigOverride(path)
        const draft = structuredClone(document)
        initialize(draft)
        const result = change(draft as ReturnType<AdminLlmPresetOptions['read']>)
        document.ai_presets = draft.ai_presets
        if ('ai' in draft) document.ai = draft.ai
        writeAtomic(path, document)
        return result
      })
    },
  }
}

/** 使用 Provider 的 DNS 固定、安全地址校验和禁止重定向的 Node 传输。 */
export function createAdminProviderModelFetcher(options: { allowLocal: boolean; createTransport?: () => ProviderTransport & { close(): Promise<void> } }): AdminLlmPresetOptions['fetchModels'] {
  return async (baseUrl, provider, apiKey, apiFormat) => {
    const transport = options.createTransport?.() ?? createNodeProviderTransport({ allowLocal: options.allowLocal, connectTimeoutMs: 8000 })
    try {
      const rows = await listProviderModels({ base_url: baseUrl, provider, api_key: apiKey, api_format: apiFormat,
        model: 'model-list', timeout_ms: 8000 }, { transport, digest: value => createHash('sha256').update(stableJson(value)).digest('hex') }, AbortSignal.timeout(8000))
      const names = rows.flatMap(row => row && typeof row === 'object' && !Array.isArray(row)
        && typeof (row as Record<string, unknown>).id === 'string' && (row as Record<string, unknown>).id
        ? [(row as Record<string, unknown>).id as string] : [])
      return [...new Set(names)].sort()
    } finally { await transport.close() }
  }
}
