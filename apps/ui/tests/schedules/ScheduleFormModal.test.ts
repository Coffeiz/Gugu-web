// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive } from 'vue'
import { createPinia } from 'pinia'
import { i18n, setLocale } from '@/i18n'
import ScheduleFormModal from '@/views/Schedules/components/ScheduleFormModal.vue'
import { scheduleAccessKey } from '@/services/scheduleAccess'
import { webScheduleAccess } from '../../src/web/schedules/access'
import { scheduledTasksApi } from '@/services/api'

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
vi.mock('@/components/common/controls/SelectPopup.vue', () => ({
  default: defineComponent({
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return () => h('div', [
        props.options?.find((option: any) => option.value === props.modelValue)?.label,
        ...(props.options ?? []).map((option: { value: string; label: string }) =>
          h('button', { onClick: () => emit('update:modelValue', option.value) }, option.label)),
      ])
    },
  }),
}))

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

it.each([
  ['ready', '私聊提醒我'],
  ['unavailable', '私聊（暂无可用会话）'],
  ['failed', '私聊状态加载失败'],
])('QQ 私聊选项区分 %s 响应', async (status, label) => {
  setLocale('zh-CN')
  const api = vi.mocked(scheduledTasksApi.listDeliveryTargets)
  if (status === 'failed') api.mockRejectedValueOnce(new Error('502'))
  else api.mockResolvedValueOnce({ groups: [], private_available: status === 'ready' })
  const host = document.createElement('div')
  document.body.append(host)
  const state = reactive({ show: false })
  const app = createApp({
    render: () => h(ScheduleFormModal, { show: state.show, imChannels: ['qq'],
      task: { id: 17, name: '旧任务', payload: '提醒内容', cron: '0 9 * * *', channels: ['qq'], enabled: true },
    }),
  })
  app.provide(scheduleAccessKey, webScheduleAccess)
  app.use(i18n).use(createPinia()).mount(host)
  cleanup = () => { app.unmount(); host.remove() }
  state.show = true
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedule-qq-delivery"]')?.textContent).toContain(label))
})

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


it('桌面复用会话选择器并提交选中的 QQ 群', async () => {
  setLocale('zh-CN')
  const host = document.createElement('div')
  document.body.append(host)
  let saved: Record<string, unknown> | undefined
  const state = reactive({ show: false })
  const app = createApp({ render: () => h(ScheduleFormModal, {
    desktop: true, show: state.show, imChannels: ['qq'],
    task: { id: 1, name: '合成提醒', payload: '合成内容', schedule_kind: 'cron',
      cron: '0 9 * * *', channels: ['qq'], enabled: true, execution_mode: 'reminder' },
    onSave: (data: Record<string, unknown>) => { saved = data },
  }) })
  app.provide(scheduleAccessKey, { ...webScheduleAccess, storesSchedulesLocally: true,
    async listDeliveryTargets() { return { private_available: true, groups: [{ chat_id: 'synthetic-group', title: '合成群聊' }] } },
  })
  app.use(i18n).use(createPinia()).mount(host)
  cleanup = () => { app.unmount(); host.remove() }
  state.show = true
  const button = (name: string) => [...host.querySelectorAll('button')].find(item => item.textContent === name)
  await vi.waitFor(() => expect(button('合成群聊')).toBeDefined())
  button('合成群聊')!.click()
  await nextTick()
  button('保存')!.click()
  expect(saved?.im_delivery).toEqual({ qq: { mode: 'group', chat_id: 'synthetic-group' } })
})
