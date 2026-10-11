// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive } from 'vue'
import { createPinia } from 'pinia'
import { i18n, setLocale } from '@/i18n'
import ScheduleFormModal from '@/views/Schedules/components/ScheduleFormModal.vue'

vi.mock('@/services/api', () => ({
  scheduledTasksApi: { listDeliveryTargets: vi.fn().mockResolvedValue({ groups: [], private_available: false }) },
}))
vi.mock('@/components/common/overlays/BaseModal.vue', () => ({
  default: defineComponent({
    props: ['show'],
    setup(_props, { slots }) { return () => h('div', slots.default?.()) },
  }),
}))
vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: defineComponent({
    props: ['disabled'],
    emits: ['click'],
    setup(props, { slots, emit }) {
      return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.())
    },
  }),
}))
vi.mock('@/components/common/controls/DatePicker.vue', () => ({ default: { render: () => h('div') } }))
vi.mock('@/components/common/controls/TimeInput.vue', () => ({ default: { render: () => h('div') } }))
vi.mock('@/components/common/icons/Icon.vue', () => ({ default: { render: () => h('span') } }))
vi.mock('@/components/AdminSelect.vue', () => ({ default: { render: () => h('div') } }))
vi.mock('@/components/common/controls/SelectPopup.vue', () => ({ default: { render: () => h('div') } }))

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

it('编辑时保留已暂停平台的渠道，新建时仍不能选择该平台', async () => {
  setLocale('zh-CN')
  const host = document.createElement('div')
  document.body.append(host)
  let saved: Record<string, any> | undefined
  const state = reactive({ show: false })
  const app = createApp({
    render: () => h(ScheduleFormModal, {
      show: state.show,
      task: {
        id: 17, name: '旧任务', payload: '提醒内容', cron: '0 9 * * *',
        schedule_kind: 'cron', channels: ['web', 'telegram'], enabled: true,
        delivery_targets: { telegram: { platform: 'telegram', chat_type: 'c2c', puid: 'owner' } },
      },
      imChannels: ['qq'],
      onSave: (data: Record<string, any>) => { saved = data },
    }),
  })
  app.use(i18n)
  app.use(createPinia())
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)
  state.show = true
  await nextTick()

  const nameInput = host.querySelector<HTMLInputElement>('.title-input')
  expect(nameInput).not.toBeNull()
  if (nameInput) {
    nameInput.value = '改过名称'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const telegramLabel = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('Telegram'))
  expect(telegramLabel?.textContent).toContain('平台已暂停')
  expect(telegramLabel?.querySelector('input')?.checked).toBe(true)

  ;[...host.querySelectorAll('button')].find(button => button.textContent === '保存')?.click()
  await nextTick()
  expect(saved?.name).toBe('改过名称')
  expect(saved?.channels).toEqual(['web', 'telegram'])

  cleanup()
  cleanup = undefined
  host.remove()

  const newHost = document.createElement('div')
  document.body.append(newHost)
  const newState = reactive({ show: false })
  const newApp = createApp({
    render: () => h(ScheduleFormModal, { show: newState.show, task: null, imChannels: ['qq'] }),
  })
  newApp.use(i18n)
  newApp.use(createPinia())
  cleanup = () => { newApp.unmount(); newHost.remove() }
  newApp.mount(newHost)
  newState.show = true
  await nextTick()
  expect([...newHost.querySelectorAll('label')].some(label => label.textContent?.includes('Telegram'))).toBe(false)
})
