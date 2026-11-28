// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, type Slots } from 'vue'
import TelegramTokenDialog from '@/components/common/gugu-chat/TelegramTokenDialog.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/common/overlays/BaseModal.vue', () => ({
  default: {
    props: ['show'],
    setup(_props: unknown, { slots }: { slots: Slots }) {
      return () => h('div', { class: 'test-modal' }, slots.default?.())
    },
  },
}))
vi.mock('@/components/common/overlays/CloseButton.vue', () => ({ default: { render: () => h('button') } }))

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

it('Telegram 连接弹窗按钮按文案自然撑开，避免固定窄按钮裁切文字', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(TelegramTokenDialog, { show: true, busy: false, error: '' })
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)

  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.app-action-button')]
  expect(buttons).toHaveLength(2)
  expect(buttons.every(button => button.classList.contains('is-fit'))).toBe(true)
})
