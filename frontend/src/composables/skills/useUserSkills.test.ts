import { createApp, nextTick, onMounted } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userSkillsApi } from '@/services/api'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'
import { useUserSkills } from './useUserSkills'

vi.mock('vue-i18n', async importOriginal => {
  const original = await importOriginal<typeof import('vue-i18n')>()
  return { ...original, useI18n: () => ({ t: (key: string) => key }) }
})

describe('useUserSkills', () => {
  afterEach(() => vi.restoreAllMocks())

  it('MCP 开关变化时刷新 Skill 可关联工具，卸载后解除监听', async () => {
    const list = vi.spyOn(userSkillsApi, 'list')
      .mockResolvedValueOnce({ skills: [], tools: [{ name: 'http_get', description_short: '网页读取', category: 'web', enabled: true }] })
      .mockResolvedValueOnce({ skills: [], tools: [{ name: 'mcp_notes_search', description_short: '搜索笔记', category: 'mcp', enabled: true }] })
    let state!: ReturnType<typeof useUserSkills>
    const app = createApp({
      setup() {
        state = useUserSkills()
        onMounted(() => { void state.load() })
        return () => null
      },
    })
    app.mount(document.createElement('div'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.tools.value.map(tool => tool.name)).toEqual(['http_get'])

    window.dispatchEvent(new Event(RESOURCE_REFRESH_EVENTS.mcp))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(list).toHaveBeenCalledTimes(2)
    expect(state.tools.value.map(tool => tool.name)).toEqual(['mcp_notes_search'])

    app.unmount()
    window.dispatchEvent(new Event(RESOURCE_REFRESH_EVENTS.mcp))
    await nextTick()
    expect(list).toHaveBeenCalledTimes(2)
  })
})
