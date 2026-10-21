// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cfg: { agent: { enabled: true }, search: { searxng_url: 'initial', deep_research_provider: 'tavily', similar_image_provider: 'baidu_qianfan', tavily_api_key: '' } },
  saveConfig: vi.fn(),
}))
vi.mock('@/stores/config', () => ({ useConfigStore: () => mocks }))
vi.mock('@/stores/admin', () => ({ useAdminStore: () => ({ authFetch: vi.fn() }) }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } }, translateAgentError: (key: string) => key }))

import { useAgentRuntimeConfig } from '@/views/Admin/Agent/runtime-config/useAgentRuntimeConfig'

type RuntimeConfig = ReturnType<typeof useAgentRuntimeConfig>
// 语音已独立为预设管理，保存与重载契约由 useVoicePresets.test.ts 覆盖。
const modes = ['行为', '深度研究', '通用搜索', '相似图片'] as const
function select(config: RuntimeConfig, mode: typeof modes[number]) {
  switch (mode) {
    case '行为': return { section: 'agent', draft: config.agentDraft, saving: config.behaviorSaving, saved: config.behaviorSaved, error: config.behaviorError, save: config.saveBehavior }
    case '深度研究': return { section: 'search', draft: config.deepResearchDraft, saving: config.deepResearchSaving, saved: config.deepResearchSaved, error: config.deepResearchError, save: config.saveDeepResearch }
    case '通用搜索': return { section: 'search', draft: config.generalSearchDraft, saving: config.generalSearchSaving, saved: config.generalSearchSaved, error: config.generalSearchError, save: () => config.saveSearch('general') }
    case '相似图片': return { section: 'search', draft: config.similarImageDraft, saving: config.similarImageSaving, saved: config.similarImageSaved, error: config.similarImageError, save: () => config.saveSearch('similar') }
  }
}

beforeEach(() => { vi.useFakeTimers(); mocks.saveConfig.mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('运行配置分区保存', () => {
  it.each(modes)('%s 只提交该分区草案，并保留保存中与三秒成功提示', async mode => {
    let resolve!: () => void
    mocks.saveConfig.mockReturnValue(new Promise<void>(done => { resolve = done }))
    const selected = select(useAgentRuntimeConfig(), mode)
    const expectedDraft = { ...selected.draft }
    selected.error.value = '旧错误'
    const saving = selected.save()
    expect(selected.saving.value).toBe(true)
    expect(selected.saved.value).toBe(false)
    expect(selected.error.value).toBe('')
    expect(mocks.saveConfig).toHaveBeenCalledWith({ [selected.section]: expectedDraft })
    resolve()
    await saving
    expect(selected.saving.value).toBe(false)
    expect(selected.saved.value).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(selected.saved.value).toBe(false)
  })

  it.each(modes)('%s 保存失败保留错误反馈和草案，并结束保存状态', async mode => {
    mocks.saveConfig.mockRejectedValue(new Error('保存失败'))
    const selected = select(useAgentRuntimeConfig(), mode)
    const draft = { ...selected.draft }
    await selected.save()
    expect(selected.saving.value).toBe(false)
    expect(selected.saved.value).toBe(false)
    expect(selected.error.value).toBe('保存失败')
    expect(selected.draft).toEqual(draft)
  })


})
