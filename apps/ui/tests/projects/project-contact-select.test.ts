// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { i18n } from '@/i18n'
import { projectAccessKey, type ProjectAccess } from '@/api/projects'
import ProjectContactSelect from '@/views/Projects/components/ProjectContactSelect.vue'

async function render(contacts: { name: string }[]) {
  i18n.global.locale.value = 'zh-CN'
  const host = document.createElement('div')
  document.body.append(host)
  const changed = vi.fn()
  const app = createApp(ProjectContactSelect, { modelValue: '', 'onUpdate:modelValue': changed })
  app.use(i18n)
  app.provide(projectAccessKey, { listContacts: async () => contacts } as ProjectAccess)
  app.mount(host)
  await Promise.resolve(); await nextTick()
  host.querySelector('button')!.click()
  await nextTick()
  return { host, changed, cleanup() { app.unmount(); host.remove() } }
}

it('仅选择已有联系人或无，不提供手工输入', async () => {
  const view = await render([{ name: '小北' }, { name: '小北' }, { name: '小南' }])
  try {
    expect(view.host.querySelector('input')).toBeNull()
    const options = [...document.querySelectorAll<HTMLButtonElement>('.select-popup-host .popup-menu-item')]
    expect(options.map(option => option.textContent?.trim())).toEqual(['无', '小北', '小南'])
    options[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(view.changed).toHaveBeenCalledWith('小北')
  } finally { view.cleanup() }
})

it('联系人为空时仍保留无选项', async () => {
  const view = await render([])
  try {
    const options = [...document.querySelectorAll<HTMLButtonElement>('.select-popup-host .popup-menu-item')]
    expect(options.map(option => option.textContent?.trim())).toEqual(['无'])
    options[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(view.changed).toHaveBeenCalledWith('')
  } finally { view.cleanup() }
})
