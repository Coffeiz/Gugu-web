import { createApp, nextTick, onMounted } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { skillAccessKey } from '@/services/resourceAccess'
import { userSkillsApi, type UserSkillItem } from '@/services/api'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'
import { useUserSkills } from '@/composables/skills/useUserSkills'

vi.mock('vue-i18n', async importOriginal => {
  const original = await importOriginal<typeof import('vue-i18n')>()
  return { ...original, useI18n: () => ({ t: (key: string) => key }) }
})

describe('useUserSkills', () => {
  afterEach(() => vi.restoreAllMocks())

  it('从注入的资源接口读取技能与工具', async () => {
    const webList = vi.spyOn(userSkillsApi, 'list').mockResolvedValue({ skills: [] })
    const webTools = vi.spyOn(userSkillsApi, 'tools').mockResolvedValue({ tools: [] })
    const tool = { name: 'local_notes', description_short: '本地笔记', category: 'notes', enabled: true }
    let state!: ReturnType<typeof useUserSkills>
    const app = createApp({
      setup() {
        state = useUserSkills()
        return () => null
      },
    })
    app.provide(skillAccessKey, {
      api: { ...userSkillsApi, list: async () => ({ skills: [] }), tools: async () => ({ tools: [tool] }) },
      configureWithChat: false,
    })
    app.mount(document.createElement('div'))
    try {
      await Promise.all([state.load(), state.loadTools()])
      expect(state.tools.value).toEqual([tool])
      expect(webList).not.toHaveBeenCalled()
      expect(webTools).not.toHaveBeenCalled()
    } finally {
      app.unmount()
    }
  })

  it('编辑技能时仅在关联改变后提交工具字段', async () => {
    const original = {
      id: 'U1', name: '合成技能', description_short: '读取文件', category: 'personal',
      body: '旧正文', related_tools: ['read_file'], enabled: true,
    } as UserSkillItem
    const update = vi.spyOn(userSkillsApi, 'update').mockResolvedValue(original)
    vi.spyOn(userSkillsApi, 'list').mockResolvedValue({ skills: [original] })
    let state!: ReturnType<typeof useUserSkills>
    const app = createApp({ setup() { state = useUserSkills(); return () => null } })
    app.mount(document.createElement('div'))
    try {
      const fields = {
        name: original.name, description_short: original.description_short, category: original.category, body: '新正文',
      }
      await state.save({ ...fields, related_tools: ['read_file'] }, original)
      await state.save({ ...fields, related_tools: [] }, original)
      expect(update.mock.calls).toEqual([
        ['U1', fields],
        ['U1', { ...fields, related_tools: [] }],
      ])
    } finally {
      app.unmount()
    }
  })

  it('MCP 开关变化时刷新 Skill 可关联工具，卸载后解除监听', async () => {
    const list = vi.spyOn(userSkillsApi, 'list').mockResolvedValue({ skills: [] })
    const listTools = vi.spyOn(userSkillsApi, 'tools')
      .mockResolvedValueOnce({ tools: [{ name: 'http_get', description_short: '网页读取', category: 'web', enabled: true }] })
      .mockResolvedValueOnce({ tools: [{ name: 'mcp_notes_search', description_short: '搜索笔记', category: 'mcp', enabled: true }] })
    let state!: ReturnType<typeof useUserSkills>
    const app = createApp({
      setup() {
        state = useUserSkills()
        onMounted(() => {
          void state.load()
          void state.loadTools()
        })
        return () => null
      },
    })
    app.mount(document.createElement('div'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.tools.value.map(tool => tool.name)).toEqual(['http_get'])

    window.dispatchEvent(new Event(RESOURCE_REFRESH_EVENTS.mcp))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(list).toHaveBeenCalledTimes(2)
    expect(listTools).toHaveBeenCalledTimes(2)
    expect(state.tools.value.map(tool => tool.name)).toEqual(['mcp_notes_search'])

    app.unmount()
    window.dispatchEvent(new Event(RESOURCE_REFRESH_EVENTS.mcp))
    await nextTick()
    expect(list).toHaveBeenCalledTimes(2)
    expect(listTools).toHaveBeenCalledTimes(2)
  })
})
