import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type Slots } from 'vue'
import SkillForm from '@/views/Skills/components/SkillForm.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/common/overlays/BaseModal.vue', () => ({
  default: {
    props: ['show'],
    setup(_props: unknown, { slots }: { slots: Slots }) {
      return () => h('div', { class: 'test-modal' }, slots.default?.())
    },
  },
}))
vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: { setup(_props: unknown, { slots }: { slots: Slots }) { return () => h('button', slots.default?.()) } },
}))
vi.mock('@/components/common/controls/Checkbox.vue', () => ({
  default: { setup(_props: unknown, { slots }: { slots: Slots }) { return () => h('div', slots.default?.()) } },
}))
vi.mock('@/components/common/overlays/CloseButton.vue', () => ({ default: { render: () => h('button') } }))
vi.mock('@/components/common/icons/Icon.vue', () => ({ default: { render: () => h('span') } }))

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

it('长工具名和说明保留完整悬停文本，且仍位于各自工具卡片内', async () => {
  const tool = {
    name: 'mcp_github_add_comment_to_pending_review',
    description_short: "Add review comment to the requester's latest pull request review",
    category: 'mcp',
    enabled: true,
  }
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(SkillForm, { show: true, skill: null, tools: [tool] })
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)

  host.querySelector<HTMLButtonElement>('.tool-toggle')?.click()
  await nextTick()

  const card = host.querySelector('.tool-option')
  expect(card?.querySelector('b')?.getAttribute('title')).toBe(tool.name)
  expect(card?.querySelector('small')?.getAttribute('title')).toBe(tool.description_short)
})
