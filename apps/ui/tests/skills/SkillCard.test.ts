import { expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import SkillCard from '@/views/Skills/components/SkillCard.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

it('文件技能提供编辑、启停和删除操作', () => {
  const host = document.createElement('div')
  const toggle = vi.fn()
  const edit = vi.fn()
  const app = createApp(SkillCard, { skill: { id: 'demo', name: '示例', description_short: '描述',
    related_tools: [], enabled: true, storage_kind: 'file' }, onToggle: toggle, onEdit: edit })
  app.mount(host)
  try {
    expect(host.textContent).toContain('示例')
    host.querySelector<HTMLButtonElement>('.toggle-switch')?.click()
    host.querySelector<HTMLButtonElement>('.card-link-btn')?.click()
    expect(toggle).toHaveBeenCalledOnce()
    expect(edit).toHaveBeenCalledOnce()
    expect(host.querySelectorAll('.card-link-btn')).toHaveLength(2)
  } finally { app.unmount() }
})
