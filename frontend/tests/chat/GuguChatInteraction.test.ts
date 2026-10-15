// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import GuguChatInteraction from '@/components/common/gugu-chat/GuguChatInteraction.vue'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

function interactionMessage(options: NonNullable<ChatMessage['interaction']>['options'] = []): ChatMessage {
  return {
    id: 17,
    role: 'interaction',
    text: '',
    time: '09:30',
    interaction: {
      promptId: 42,
      kind: 'confirm',
      title: '确认操作',
      body: '请确认是否继续',
      options,
    },
  }
}

function mountInteraction(
  msg: ChatMessage,
  onSelect = vi.fn(),
  answerMode: 'inline' | 'composer' = 'composer',
  onTextSubmit = vi.fn(),
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({
    setup: () => () => h(GuguChatInteraction, { msg, onSelect, answerMode, onTextSubmit }),
  }))
  app.mount(host)
  return { app, host, onSelect, onTextSubmit }
}

let mounted: ReturnType<typeof mountInteraction> | undefined

afterEach(() => {
  mounted?.app.unmount()
  mounted?.host.remove()
  mounted = undefined
  vi.useRealTimers()
})

describe('GuguChatInteraction', () => {
  it('旧提问没有选项时不渲染空操作区或悬空分隔线', () => {
    mounted = mountInteraction(interactionMessage())

    expect(mounted.host.querySelector('.interaction-actions')).toBeNull()
    expect(mounted.host.querySelector('.interaction-title')?.textContent).toBe('确认操作')
  })

  it('选择确认项会发出消息和选项，并立即禁用重复提交', async () => {
    const msg = interactionMessage([{ id: 'confirm', label: '确认', token: 'yes' }])
    mounted = mountInteraction(msg)
    const button = mounted.host.querySelector('.interaction-option') as HTMLButtonElement

    expect(button.textContent?.trim()).toBe('确认')
    button.click()
    await nextTick()

    expect(mounted.onSelect).toHaveBeenCalledWith(msg, { id: 'confirm', label: '确认', token: 'yes' })
    expect(button.disabled).toBe(true)
    expect(mounted.host.querySelector('.interaction-resolved')?.textContent).toContain('chatUi.confirmationSubmitting')
  })

  it('开放问题仅有自定义回复入口时直接激活输入，不再发起按钮提交', async () => {
    const msg = reactive(interactionMessage([
      { id: '__custom_reply__', label: '自定义回复', token: 'fresh-token' },
    ]))
    msg.interaction!.kind = 'question'
    msg.interaction!.allowTextInput = true
    mounted = mountInteraction(msg)
    await nextTick()

    expect(msg.interaction!.customInputActive).toBe(true)
    expect(mounted.onSelect).not.toHaveBeenCalled()
    expect(mounted.host.querySelector('.interaction-option')).toBeNull()
    expect(mounted.host.querySelector('.interaction-custom-hint')?.textContent).toBe('chatUi.customReplyHint')
  })

  it('Web 开放问题在卡片内显示输入框，按 Enter 直接提交答案', async () => {
    const msg = reactive(interactionMessage())
    msg.interaction!.kind = 'question'
    msg.interaction!.allowTextInput = true
    mounted = mountInteraction(msg, vi.fn(), 'inline')
    await nextTick()

    const input = mounted.host.querySelector('textarea.interaction-answer-input') as HTMLTextAreaElement
    expect(input).not.toBeNull()
    expect(mounted.host.querySelector('.interaction-custom-hint')).toBeNull()
    input.value = '周六延期'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(mounted.onTextSubmit).toHaveBeenCalledWith(msg, '周六延期')
    expect(msg.interaction!.submitting).toBe(true)
  })

  it('无选项问题回复完成后隐藏自定义回复入口和输入提示', async () => {
    const msg = reactive(interactionMessage([
      { id: '__custom_reply__', label: '自定义回复', token: 'fresh-token' },
    ]))
    msg.interaction!.kind = 'question'
    msg.interaction!.allowTextInput = true
    msg.interaction!.customInputActive = true
    msg.interaction!.resolved = true
    msg.interaction!.responseText = '测试'
    mounted = mountInteraction(msg)
    await nextTick()

    expect(mounted.host.querySelector('.interaction-option')).toBeNull()
    expect(mounted.host.querySelector('.interaction-custom-hint')).toBeNull()
    expect(mounted.host.querySelector('.interaction-response')?.textContent).toBe('测试')
    expect(mounted.host.querySelector('.interaction-resolved')?.textContent).toContain('chatUi.submitted')
  })

  it('MCP 密码表单不展示通用交互 token，并提供专用取消事件', async () => {
    const msg = interactionMessage([
      { id: 'input_credentials', label: '输入凭据', token: 'input-token' },
      { id: 'cancel', label: '取消', token: 'cancel-token' },
    ])
    msg.interaction!.secretFields = [{ name: 'key', label: '服务 Key', type: 'secret' }]
    const onSecretCancel = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(defineComponent({
      setup: () => () => h(GuguChatInteraction, { msg, onSecretCancel }),
    }))
    app.mount(host)
    mounted = { app, host, onSelect: vi.fn(), onTextSubmit: vi.fn() }

    expect(host.querySelector('.interaction-actions')).toBeNull()
    expect(host.querySelector('input[type="password"]')).not.toBeNull()
    const cancel = host.querySelector('.interaction-secret-cancel') as HTMLButtonElement
    cancel.click()
    await Promise.resolve()

    expect(onSecretCancel).toHaveBeenCalledWith(msg)
    expect(cancel.disabled).toBe(true)
  })

  it('secret 提交失败后解除提交态会清空密码输入框', async () => {
    const msg = reactive(interactionMessage())
    msg.interaction!.secretFields = [{ name: 'key', label: '服务 Key', type: 'secret' }]
    mounted = mountInteraction(msg)
    const input = mounted.host.querySelector('input[type="password"]') as HTMLInputElement
    input.value = 'temporary-secret'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
    expect(input.value).toBe('temporary-secret')

    msg.interaction!.submitting = true
    await nextTick()
    msg.interaction!.submitting = false
    await nextTick()

    expect(input.value).toBe('')
  })

  it('不会在自定义回答请求进行中把交互卡自动标记为过期', async () => {
    vi.useFakeTimers()
    const expiresAt = new Date(Date.now() + 1000).toISOString()
    const msg = reactive(interactionMessage())
    msg.interaction!.kind = 'question'
    msg.interaction!.allowTextInput = true
    msg.interaction!.customInputActive = true
    msg.interaction!.submitting = true
    msg.interaction!.expiresAt = expiresAt
    mounted = mountInteraction(msg)

    await vi.advanceTimersByTimeAsync(1500)
    await nextTick()
    expect(msg.interaction!.expired).toBeUndefined()
    expect(mounted.host.querySelector('.interaction-resolved')?.textContent)
      .toContain('chatUi.confirmationSubmitting')

    msg.interaction!.submitting = false
    await nextTick()
    expect(msg.interaction!.expired).toBe(true)
    expect(mounted.host.querySelector('.interaction-resolved')?.textContent)
      .toContain('chatUi.expired')
  })

  it('长选项的静态布局契约允许收缩、换行并限制在气泡宽度内', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/common/gugu-chat/GuguChatInteraction.vue'), 'utf8')
    const style = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? ''
    const selector = /\.interaction-actions\s+:deep\(\.interaction-option\)\s*\{([^}]+)\}/
    const declarations = style.match(selector)?.[1]
      .split(';')
      .map(declaration => declaration.trim().split(/:\s*/, 2))
      .filter(([property, value]) => Boolean(property && value))
    const rules = new Map(declarations?.map(([property, value]) => [property, value]))

    expect(Object.fromEntries(rules)).toMatchObject({
      'min-width': '0',
      'max-width': '100%',
      'white-space': 'normal',
      'word-break': 'normal',
      'overflow-wrap': 'anywhere',
    })
  })
})
