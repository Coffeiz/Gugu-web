import { createApp, h } from 'vue'
import { expect, it, vi } from 'vitest'
import type { DesktopAgentModelCommand, DesktopAgentModelList } from '@gugu/core/desktop'
import { i18n } from '@/i18n'
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
import DesktopAgentModel from '../../src/desktop/account/DesktopAgentModel.vue'

it('取消删除时保留模型，确认时只删除选中的条目', async () => {
  const preset = { provider: 'openai', apiFormat: 'openai', baseUrl: 'https://example.test/v1' }
  const state: DesktopAgentModelList = {
    defaultId: 'first',
    items: [
      { ...preset, model: 'first-model', id: 'first' },
      { ...preset, model: 'second-model', id: 'second' },
    ],
  }
  const invoke = vi.fn(async (command: DesktopAgentModelCommand) => {
    if (command.action === 'delete') state.items = state.items.filter(item => item.id !== command.id)
    return { ok: true, result: structuredClone(state) }
  })
  vi.stubGlobal('guguDesktop', { agentModel: invoke })

  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => [h(DesktopAgentModel), h(ConfirmDialog)] }).use(i18n)
  app.mount(host)
  try {
    const removeSecond = () => host.querySelectorAll<HTMLButtonElement>('.byok-card .pm-danger-btn')[1]?.click()
    await vi.waitFor(() => expect(host.querySelectorAll('.byok-card')).toHaveLength(2))
    removeSecond()
    await vi.waitFor(() => {
      expect(host.querySelector('.confirm-dialog')?.textContent).toContain('second-model')
    })
    host.querySelector<HTMLButtonElement>('.confirm-dialog-cancel')!.click()
    await vi.waitFor(() => {
      expect(host.querySelector('.confirm-dialog')).toBeNull()
      expect(host.querySelectorAll<HTMLButtonElement>('.byok-card .pm-danger-btn')[1]?.disabled).toBe(false)
    })
    expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }))

    removeSecond()
    await vi.waitFor(() => expect(host.querySelector('.confirm-dialog-confirm')).not.toBeNull())
    host.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click()
    await vi.waitFor(() => expect(host.querySelectorAll('.byok-card')).toHaveLength(1))
    expect(host.querySelector('.byok-card')?.textContent).toContain('first-model')
    expect(invoke).toHaveBeenCalledWith({ action: 'delete', id: 'second' })
  } finally {
    app.unmount()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('在模型卡片检测三种媒体并保留未知能力的原设置', async () => {
  const item = { id: 'first', provider: 'openai', apiFormat: 'openai', baseUrl: 'https://example.test/v1', model: 'test-model', audio: true }
  const invoke = vi.fn(async (command: DesktopAgentModelCommand) => {
    if (command.action === 'probe') {
      const supported = command.dim === 'audio' ? null : command.dim === 'image'
      return { ok: true, result: { dim: command.dim, supported, detail: '' } }
    }
    const entry = command.action === 'put' ? { ...item, ...command.preset } : item
    return { ok: true, result: { items: [entry], defaultId: item.id } }
  })
  vi.stubGlobal('guguDesktop', { agentModel: invoke })
  const host = document.createElement('div')
  const app = createApp({ render: () => h(DesktopAgentModel) }).use(i18n)
  app.mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('.byok-card')).not.toBeNull())
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.byok-card-actions button')]
    buttons.find(button => button.textContent === i18n.global.t('profileByokUi.probe'))!.click()
    await vi.waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command.action === 'probe').map(([command]) => 'dim' in command && command.dim))
        .toEqual(['image', 'video', 'audio'])
      expect(invoke).toHaveBeenCalledWith({
        action: 'put', id: item.id, preset: expect.objectContaining({ apiKey: '', image: true, audio: true, video: false }),
      })
      expect(host.querySelectorAll('.byok-capability-tag')).toHaveLength(2)
    })
  } finally {
    app.unmount()
    vi.unstubAllGlobals()
  }
})
