// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import GuguChatMessageList from '@/components/common/gugu-chat/GuguChatMessageList.vue'

vi.mock('vue-i18n', async (original) => ({
  ...await original<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))

it('消息列表可以滚到底并取消旧会话滚动', async () => {
  const list = ref<InstanceType<typeof GuguChatMessageList> | null>(null)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({ setup: () => () => h(GuguChatMessageList, {
    ref: list, messages: [{ id: 1, role: 'user', text: '测试消息', time: '12:00' }],
    sessionId: 1, isGroupSession: false, interactionAnswerMode: 'composer', copiedId: null,
    voicePlayingId: null, voiceBars: [], expanded: true, resizing: false, streaming: false,
    statusKind: 'hide', statusTyped: '', sessionSettling: false,
  }) }))
  app.mount(host)
  try {
    await nextTick()
    const element = host.querySelector<HTMLElement>('.chat-messages')!
    element.scrollTo = vi.fn()
    expect(() => list.value!.scrollToBottom()).not.toThrow()
    expect(element.scrollTo).toHaveBeenCalled()
    expect(() => list.value!.cancelScroll()).not.toThrow()
  } finally {
    app.unmount()
    host.remove()
  }
})
