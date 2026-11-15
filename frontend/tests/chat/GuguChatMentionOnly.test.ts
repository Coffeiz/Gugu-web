// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import GuguChatMessageRow from '@/components/common/gugu-chat/GuguChatMessageRow.vue'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = []

function mountRow(msg: ChatMessage) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({
    setup: () => () => h(GuguChatMessageRow, {
      msg,
      sessionId: null,
      toolExpanded: false,
      isGroupSession: true,
      interactionAnswerMode: 'composer',
      copiedId: null,
      voicePlayingId: null,
      voiceBars: [],
    }),
  }))
  app.mount(host)
  mounted.push({ app, host })
  return host
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount()
    host.remove()
  }
})

it('把空正文的结构化 @ 咕咕消息显示为专用气泡', () => {
  const host = mountRow({ id: 1, role: 'user', text: '', mentionOnly: true, time: '14:23' })

  expect(host.querySelector('.mention-only-bubble')?.textContent).toBe('chatUi.mentionOnly')
})

it('普通空用户消息仍不显示空气泡', () => {
  const host = mountRow({ id: 2, role: 'user', text: '', time: '14:24' })

  expect(host.querySelector('.mention-only-bubble')).toBeNull()
  expect(host.querySelector('.user-md')).toBeNull()
})
