import { createApp, h, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import GroupOwnerMemorySwitch from './GroupOwnerMemorySwitch.vue'
const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: confirm }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
describe('群聊个人记忆授权', () => {
  it('取消不会开启，确认才开启；关闭不再次询问', async () => {
    const changes = vi.fn()
    const enabled = ref(false)
    const host = document.createElement('div')
    const app = createApp({ render: () => h(GroupOwnerMemorySwitch, { enabled: enabled.value, onChange: changes }) })
    app.mount(host)
    const button = host.querySelector('button')!
    confirm.mockResolvedValueOnce(false)
    button.click()
    await nextTick()
    expect(changes).not.toHaveBeenCalled()
    confirm.mockResolvedValueOnce(true)
    button.click()
    await nextTick()
    expect(changes).toHaveBeenCalledWith(true)
    enabled.value = true
    await nextTick()
    const count = confirm.mock.calls.length
    button.click()
    await nextTick()
    expect(changes).toHaveBeenLastCalledWith(false)
    expect(confirm.mock.calls.length).toBe(count)
    app.unmount()
  })
})
