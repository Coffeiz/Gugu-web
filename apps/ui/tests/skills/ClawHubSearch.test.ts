import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ClawHubSearch from '@/views/Skills/components/ClawHubSearch.vue'
import { skillAccessKey } from '@/services/resourceAccess'
import { userSkillsApi } from '@/services/api'

vi.mock('vue-i18n', async importOriginal => ({ ...await importOriginal<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/core/useAppToast', () => ({ showAppError: vi.fn(), showAppSuccess: vi.fn() }))

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

it('搜索后可安装对应技能并向当前宿主提交来源', async () => {
  const search = vi.fn().mockResolvedValue({ skills: [{ slug: 'demo', name: '示例', description: '描述', version: null,
    owner: 'sample', reference: 'sample/demo', url: 'https://clawhub.ai/sample/skills/demo' }] })
  const install = vi.fn().mockResolvedValue({ id: 'demo' })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(ClawHubSearch)
  app.provide(skillAccessKey, { api: { ...userSkillsApi, searchClawHub: search, installClawHub: install }, configureWithChat: false })
  app.mount(host)
  cleanup = () => { app.unmount(); host.remove() }
  const input = host.querySelector('input')!
  input.value = '资料'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
  expect(search).toHaveBeenCalledWith('资料')
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('clawhub.install'))!
  button.click()
  await nextTick()
  expect(install).toHaveBeenCalledWith('sample/demo')
})
