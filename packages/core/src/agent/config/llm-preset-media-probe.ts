import { capabilitySnapshot, type ProviderConfig } from '../providers/index.js'
import { ensureLlmPresets, LlmStrategyConfigurationError, type LlmStrategyMutator } from './llm-strategy.js'
import { llmAiSegment } from './llm-preset-selection.js'

type Document = Record<string, unknown>
export type LlmMediaDimension = 'image' | 'video' | 'audio'
export interface LlmMediaProbeResult { dim: LlmMediaDimension; supported: boolean | null; status: number; detail: string }
export class LlmPresetMediaProbeError extends Error {
  override name = 'LlmPresetMediaProbeError'
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message) }
}

const record = (value: unknown): value is Document => !!value && typeof value === 'object' && !Array.isArray(value)
const dimensions: readonly LlmMediaDimension[] = ['image', 'video', 'audio']
function fingerprint(item: Document): string {
  return ['provider', 'local_runtime', 'base_url', 'model'].map(key => {
    const value = Object.hasOwn(item, key) ? item[key] : ''
    return value === null ? 'None' : value === true ? 'True' : value === false ? 'False' : String(value)
  }).join('|')
}

export function createLlmPresetMediaProbe(ports: {
  readDocument(): unknown | Promise<unknown>
  mutate: LlmStrategyMutator
  probe(config: ProviderConfig, dim: LlmMediaDimension): Promise<Omit<LlmMediaProbeResult, 'dim'> | LlmMediaProbeResult>
  invalidate(): Promise<unknown>
}) {
  return async (id: string, dim?: LlmMediaDimension) => {
    let item: Document
    try {
      const raw = await ports.readDocument()
      if (!record(raw)) throw new Error('invalid config document')
      const presets = ensureLlmPresets(structuredClone(raw))
      if (!Array.isArray(presets.items)) throw new Error('invalid preset list')
      const found = presets.items.find(value => record(value) && value.id === id)
      if (!record(found)) throw new LlmPresetMediaProbeError(404, '预设不存在')
      item = structuredClone(found)
    } catch (error) {
      if (error instanceof LlmPresetMediaProbeError) throw error
      throw new LlmPresetMediaProbeError(503, '暂时无法读取模型配置')
    }
    const selectedDimensions = dim ? [dim] : dimensions
    if (selectedDimensions.some(value => !dimensions.includes(value)))
      throw new LlmPresetMediaProbeError(400, 'dim 仅支持 image/video/audio')
    let declaredCapabilities: Record<string, unknown>
    try { declaredCapabilities = capabilitySnapshot(item as ProviderConfig) }
    catch { throw new LlmPresetMediaProbeError(503, '暂时无法读取模型配置') }

    const expectedFingerprint = fingerprint(item)
    const results: Partial<Record<LlmMediaDimension, LlmMediaProbeResult>> = {}
    for (const currentDim of selectedDimensions) {
      try {
        const result = await ports.probe(item as ProviderConfig, currentDim)
        results[currentDim] = { dim: currentDim, ...result }
      } catch {
        results[currentDim] = { dim: currentDim, supported: null, status: 0, detail: '未能判定：Provider 网络请求失败或超时' }
      }
    }

    try {
      await ports.mutate(document => {
        let presets: Document
        try { presets = ensureLlmPresets(document) }
        catch { throw new LlmStrategyConfigurationError() }
        if (!Array.isArray(presets.items)) throw new LlmStrategyConfigurationError()
        const current = presets.items.find(value => record(value) && value.id === id)
        if (!record(current)) throw new LlmPresetMediaProbeError(404, '预设不存在')
        if (fingerprint(current) !== expectedFingerprint)
          throw new LlmPresetMediaProbeError(409, '探测期间预设已更改，请重新探测')
        for (const currentDim of selectedDimensions) {
          const supported = results[currentDim]?.supported
          if (supported !== null && supported !== undefined) current[currentDim] = Boolean(supported)
        }
        if (presets.active_id === id) document.ai = llmAiSegment(current)
      })
    } catch (error) {
      if (error instanceof LlmPresetMediaProbeError) throw error
      throw new LlmPresetMediaProbeError(503, '暂时无法保存模型配置')
    }
    await ports.invalidate()

    if (selectedDimensions.length === 1) {
      const currentDim = selectedDimensions[0]!
      const result = results[currentDim]!
      return { ...result, declared_capabilities: declaredCapabilities,
        probe: { supported: result.supported, status: result.status } }
    }
    return { results, declared_capabilities: declaredCapabilities, probe: results }
  }
}
