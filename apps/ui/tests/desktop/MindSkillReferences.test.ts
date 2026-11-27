import { describe, expect, it, vi } from 'vitest'
import { desktopMindAccess } from '@desktop/mind/access'

vi.mock('@desktop/bridge/bridge', () => ({
  desktopData: { clients: async () => [], projects: async () => [], calendar: async () => [] },
  requestDesktopFile: async () => [],
}))
vi.mock('@desktop/resources/transport', () => ({
  desktopSkillsApi: { list: async () => ({ skills: [
    { id: 'demo', name: '文件整理', description_short: '自动归档' },
    { id: 'other', name: '绘画', description_short: '草图' },
  ] }) },
}))

describe('桌面引用建议', () => {
  it('根据名称或描述找到文件技能，返回技能目录编号', async () => {
    expect(await desktopMindAccess.refSuggest('归档')).toEqual([
      { type: 'skill', id: 'demo', label: '文件整理', subtitle: '自动归档' },
    ])
  })
})
