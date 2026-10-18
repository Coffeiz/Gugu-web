// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'
import UsageScenarioTable from '@/views/Admin/Agent/observability/components/UsageScenarioTable.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => { app?.unmount(); host?.remove() })

describe('场景冷请求统计', () => {
  it('展示服务端加权缓存率，周期数据变化后更新，不把无样本显示成零', async () => {
    const row = { scenario: 'reflection', calls: 7, tokens_in: 620225, tokens_out: 2925,
      cache_ratio: 0.71138, cold_calls: 1, warm_cache_ratio: 0.851463 as number | null }
    const props = reactive({ rows: [row], formatNumber: (value: number) => String(value) })
    host = document.createElement('div'); document.body.appendChild(host)
    app = createApp(UsageScenarioTable, props); app.mount(host)
    const values = () => Array.from(host!.querySelectorAll('tbody td')).map(cell => cell.textContent)
    expect(values()).toEqual(['7', '620225', '2925', '71.1%', '1', '85.1%'])
    props.rows[0]!.cold_calls = 7
    props.rows[0]!.warm_cache_ratio = null
    await nextTick()
    expect(values().slice(-2)).toEqual(['7', '—'])
    props.rows[0]!.cold_calls = 0
    props.rows[0]!.warm_cache_ratio = 0
    await nextTick()
    expect(values().slice(-2)).toEqual(['0', '0.0%'])
  })
})
