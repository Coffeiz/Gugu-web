// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import GuguChatWorkspace from '@/components/common/gugu-chat/GuguChatWorkspace.vue'

it('会话顶栏通过同一个选择器切换已登记目录和个人文件', async () => {
  const list = vi.fn().mockResolvedValue([{ id: 7, name: '合成工作区' }])
  const select = vi.fn().mockResolvedValue(undefined)
  const onChange = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(GuguChatWorkspace, { sessionId: 42, name: '个人文件', access: { list, select }, onChange })
  app.use(createI18n({ legacy: false, locale: 'zh', messages: {
    zh: { filesUi: { personalFiles: '个人文件' }, projectWorkspaceUi: { select: '选择工作区' } },
  } }))
  app.mount(host)
  try {
    const trigger = host.querySelector('button')!
    async function choose(label: string) {
      trigger.click()
      await vi.waitFor(() => {
        expect([...document.querySelectorAll<HTMLButtonElement>('button')]
          .some(button => button.textContent?.trim() === label && !button.disabled && button !== trigger && !button.closest('.menu-pop-leave-active'))).toBe(true)
      })
      const option = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === label && !button.disabled && button !== trigger && !button.closest('.menu-pop-leave-active'))!
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      option.click()
      await Promise.resolve()
      await nextTick()
    }
    await choose('合成工作区')
    expect(select).toHaveBeenLastCalledWith(42, 7)
    expect(onChange).toHaveBeenLastCalledWith(42, '合成工作区')
    await choose('个人文件')
    expect(select).toHaveBeenLastCalledWith(42, 'personal')
    expect(onChange).toHaveBeenLastCalledWith(42, null)
  } finally {
    app.unmount()
    host.remove()
  }
})
