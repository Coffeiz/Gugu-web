// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import MessageFormatSettings from '@/components/common/profile/MessageFormatSettings.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

describe('QQ 消息格式设置', () => {
  it('仅提供兼容与 Markdown 两种格式，并把缺失私聊设置显示为 Markdown', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () => h(MessageFormatSettings, { bot: { id: 1 } }),
    })
    app.mount(host)

    const rows = host.querySelectorAll('.pm-bot-group-row')
    expect(host.querySelectorAll('.pm-style-chip')).toHaveLength(4)
    expect(rows[0].querySelector('.pm-style-chip.active')?.textContent).toBe('profileImUi.compatFormat')
    expect(rows[1].querySelector('.pm-style-chip.active')?.textContent).toBe('profileImUi.markdownFormat')
  })

  it('选择另一种格式时按会话范围提交稳定的配置值', async () => {
    const changes: Array<[string, string]> = []
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () => h(MessageFormatSettings, {
        bot: { id: 1, group_message_format: 'compat', private_message_format: 'markdown' },
        onChange: (scope: string, mode: string) => changes.push([scope, mode]),
      }),
    })
    app.mount(host)

    const groupOptions = host.querySelectorAll('.pm-bot-group-row')[0].querySelectorAll('button')
    const privateOptions = host.querySelectorAll('.pm-bot-group-row')[1].querySelectorAll('button')
    ;(groupOptions[1] as HTMLButtonElement).click()
    ;(privateOptions[0] as HTMLButtonElement).click()

    expect(changes).toEqual([['group', 'markdown'], ['private', 'compat']])
  })
})
