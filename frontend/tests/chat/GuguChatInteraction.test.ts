// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
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

function mountInteraction(msg: ChatMessage, onSelect = vi.fn()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({
    setup: () => () => h(GuguChatInteraction, { msg, onSelect }),
  }))
  app.mount(host)
  return { app, host, onSelect }
}

let mounted: ReturnType<typeof mountInteraction> | undefined

afterEach(() => {
  mounted?.app.unmount()
  mounted?.host.remove()
  mounted = undefined
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
    await Promise.resolve()

    expect(mounted.onSelect).toHaveBeenCalledWith(msg, { id: 'confirm', label: '确认', token: 'yes' })
    expect(button.disabled).toBe(true)
    expect(mounted.host.querySelector('.interaction-resolved')?.textContent).toContain('chatUi.confirmationSubmitting')
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
