// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { installEnterDirective } from '@/directives/enter'
import SessionTitleEdit from '@/components/common/gugu-chat/SessionTitleEdit.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

type MountedEditor = { app: ReturnType<typeof createApp>; host: HTMLDivElement }
const mountedEditors: MountedEditor[] = []

function mountEditor(header: boolean, onRename = vi.fn()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({
    setup: () => () => h(SessionTitleEdit, { title: '原会话标题', onRename, header }),
  }))
  installEnterDirective(app)
  app.mount(host)
  const mounted = { app, host, onRename }
  mountedEditors.push(mounted)
  return mounted
}

function pressEnter(target: HTMLElement, options: { isComposing?: boolean; keyCode?: number } = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
    isComposing: options.isComposing,
    keyCode: options.keyCode,
  })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  for (const { app, host } of mountedEditors.splice(0)) {
    app.unmount()
    host.remove()
  }
})

describe('GuguChat 会话重命名的 IME Enter 行为', () => {
  it('侧栏输入框组合态 Enter 保留编辑，组合完成后普通 Enter 才提交', async () => {
    const mounted = mountEditor(false)
    mounted.host.querySelector<HTMLButtonElement>('.exp-session-rename-btn')?.click()
    await nextTick()

    const input = mounted.host.querySelector<HTMLInputElement>('.rename-input-inline')!
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.value = '新会话标题'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))

    const composingEnter = pressEnter(input, { isComposing: true })
    expect(composingEnter.defaultPrevented).toBe(false)
    expect(mounted.host.querySelector('.rename-input-inline')).toBe(input)
    expect(mounted.onRename).not.toHaveBeenCalled()

    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await nextTick()
    const submitEnter = pressEnter(input)
    expect(submitEnter.defaultPrevented).toBe(true)
    expect(mounted.onRename).toHaveBeenCalledWith('新会话标题')
  })

  it('顶部 contenteditable 用旧输入法兼容码时保留预输入内容', async () => {
    const mounted = mountEditor(true)
    const title = mounted.host.querySelector<HTMLElement>('.exp-session-title.is-header')!
    title.click()
    await nextTick()
    title.innerText = '新会话标题'
    title.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))

    const composingEnter = pressEnter(title, { keyCode: 229 })
    expect(composingEnter.defaultPrevented).toBe(false)
    expect(title.getAttribute('contenteditable')).toBe('true')
    expect(title.innerText).toBe('新会话标题')
    expect(mounted.onRename).not.toHaveBeenCalled()

    title.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await nextTick()
    pressEnter(title)
    expect(mounted.onRename).toHaveBeenCalledWith('新会话标题')
  })
})
