import type { ProviderConfig } from '@gugu/core/providers'

export interface ModelPreset extends ProviderConfig { readonly id: string; readonly in_pool?: boolean }
export class ModelPresetUnavailable extends Error {}
export interface ModelSettingsSnapshot {
  readonly ai: ProviderConfig
  readonly ai_presets?: { readonly strategy?: string; readonly pool_mode?: string; readonly items?: readonly ModelPreset[] }
  readonly byokEnabled: boolean
  readonly systemPrompt: string
  /** 入队时冻结的上下文 scope key，供恢复时和可信选择策略逐项比较。 */
  readonly contextScopeKey?: string
  /** 服务端生成的不可逆范围标识，权限、模型配置和凭据版本变化时必须更新。 */
  readonly accessScopeHash: string
}

/** 与 Python 一样按进程维护轮询游标及在途数；不声称跨 worker 全局负载均衡。 */
export function createModelStrategy(read: (ownerId: string, signal: AbortSignal) => Promise<ModelSettingsSnapshot>, random = Math.random) {
  let cursor = 0
  const inflight = new Map<string, number>()
  return async (ownerId: string, signal: AbortSignal, ref?: string) => {
    const settings = structuredClone(await read(ownerId, signal))
    signal.throwIfAborted()
    const pool = settings.ai_presets?.items?.filter(item => item.in_pool) ?? []
    const mode = settings.ai_presets?.pool_mode ?? 'random'
    let model: ProviderConfig = settings.ai, reserved: string | null = null, modelRef = 'active'
    if (ref !== undefined) {
      if (ref !== 'active') {
        if (!ref.startsWith('preset:')) throw new ModelPresetUnavailable('模型预设不存在')
        const preset = settings.ai_presets?.items?.find(item => item.id === ref.slice(7))
        if (!preset) throw new ModelPresetUnavailable('模型预设不存在')
        model = preset; modelRef = ref
        if (settings.ai_presets?.strategy === 'pool' && mode === 'least_loaded') { reserved = preset.id; inflight.set(preset.id, (inflight.get(preset.id) ?? 0) + 1) }
      }
    } else if (settings.ai_presets?.strategy === 'pool' && pool.length) {
      if (mode === 'round_robin') { model = pool[cursor % pool.length]!; cursor = (cursor + 1) % Number.MAX_SAFE_INTEGER }
      else if (mode === 'least_loaded') {
        const chosen = pool.reduce((best, item) => (inflight.get(item.id) ?? 0) < (inflight.get(best.id) ?? 0) ? item : best)
        model = chosen; reserved = chosen.id; inflight.set(chosen.id, (inflight.get(chosen.id) ?? 0) + 1)
      } else {
        const value = random()
        if (!(value >= 0 && value < 1)) throw new RangeError('随机数无效')
        model = pool[Math.floor(value * pool.length)]!
      }
      modelRef = `preset:${(model as ModelPreset).id}`
    }
    let released = false
    return { config: structuredClone(model), modelRef, systemPrompt: settings.systemPrompt, byokEnabled: settings.byokEnabled,
      contextScopeKey: settings.contextScopeKey, accessScopeHash: settings.accessScopeHash, localDeployment: settings.ai.deployment_mode === 'local', release: () => {
        if (released) return
        released = true
        if (reserved) { const count = inflight.get(reserved) ?? 0; if (count <= 1) inflight.delete(reserved); else inflight.set(reserved, count - 1) }
      } }
  }
}
