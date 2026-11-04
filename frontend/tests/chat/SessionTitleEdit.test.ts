// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { installEnterDirective } from '@/directives/enter'
import SessionTitleEdit from '@/components/common/gugu-chat/SessionTitleEdit.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

// jsdom 没实现 innerText。浏览器里 `el.innerText = x` 是「整体替换子节点」——会把 Vue
// 持有的那个文本节点换掉，这是「改名后标题再也不更新」这个 bug 的触发条件。
// 补上这层行为，测试里的 DOM 变化才和真实浏览器一致。
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  get(this: HTMLElement) { return this.textContent ?? '' },
  set(this: HTMLElement, value: string) { this.textContent = value },
  configurable: true,
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

/**
 * 顶部标题栏的真实用法：父组件持有标题，改名成功后把新标题传回来。
 * 返回的 title 是父组件的响应式标题，切换会话时改它就等价于换了一个会话。
 */
function mountHeaderEditor(initialTitle = '原会话标题') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const title = ref(initialTitle)
  const app = createApp(defineComponent({
    setup: () => () => h(SessionTitleEdit, {
      title: title.value,
      header: true,
      onRename: (next: string) => { title.value = next },
    }),
  }))
  installEnterDirective(app)
  app.mount(host)
  mountedEditors.push({ app, host })
  const el = host.querySelector<HTMLElement>('.exp-session-title.is-header')!
  return { app, host, el, title }
}

/** 模拟用户在 contenteditable 里输入：浏览器直接改写 DOM 文本节点。 */
function typeIntoHeader(el: HTMLElement, text: string) {
  el.textContent = text
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
    typeIntoHeader(title, '新会话标题')
    title.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))

    const composingEnter = pressEnter(title, { keyCode: 229 })
    expect(composingEnter.defaultPrevented).toBe(false)
    expect(title.getAttribute('contenteditable')).toBe('true')
    expect(title.textContent).toBe('新会话标题')
    expect(mounted.onRename).not.toHaveBeenCalled()

    title.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await nextTick()
    pressEnter(title)
    expect(mounted.onRename).toHaveBeenCalledWith('新会话标题')
  })
})

describe('GuguChat 顶部标题栏改名', () => {
  it('改名成功后标题栏显示新名字', async () => {
    const { el, title } = mountHeaderEditor()
    expect(el.textContent).toBe('原会话标题')

    el.click()
    await nextTick()
    expect(el.getAttribute('contenteditable')).toBe('true')

    typeIntoHeader(el, '新会话标题')
    el.dispatchEvent(new FocusEvent('blur'))
    await nextTick()
    await nextTick()

    expect(title.value).toBe('新会话标题')
    expect(el.textContent).toBe('新会话标题')
  })

  it('改名后切换会话，标题栏跟着显示新会话的名字', async () => {
    const { el, title } = mountHeaderEditor()

    el.click()
    await nextTick()
    typeIntoHeader(el, '新会话标题')
    el.dispatchEvent(new FocusEvent('blur'))
    await nextTick()
    await nextTick()
    expect(el.textContent).toBe('新会话标题')

    // 切到另一个会话
    title.value = '另一个会话'
    await nextTick()
    expect(el.textContent).toBe('另一个会话')
  })

  it('Esc 取消后标题栏还原成原标题', async () => {
    const { el, title } = mountHeaderEditor()

    el.click()
    await nextTick()
    typeIntoHeader(el, '敲了一半又取消')
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    await nextTick()

    expect(title.value).toBe('原会话标题')
    expect(el.textContent).toBe('原会话标题')
    expect(el.getAttribute('contenteditable')).toBe('false')
  })

  it('改回与原标题相同的名字时不发改名请求，标题栏保持原样', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const onRename = vi.fn()
    const title = ref('原会话标题')
    const app = createApp(defineComponent({
      setup: () => () => h(SessionTitleEdit, { title: title.value, header: true, onRename }),
    }))
    installEnterDirective(app)
    app.mount(host)
    mountedEditors.push({ app, host })
    const el = host.querySelector<HTMLElement>('.exp-session-title.is-header')!

    el.click()
    await nextTick()
    typeIntoHeader(el, '原会话标题')
    el.dispatchEvent(new FocusEvent('blur'))
    await nextTick()
    await nextTick()

    expect(onRename).not.toHaveBeenCalled()
    expect(el.textContent).toBe('原会话标题')
  })
})
