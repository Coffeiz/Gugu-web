import { expect, it } from 'vitest'
import type { ProviderEvent } from '../../../src/agent/models.js'
import { collect, fixture, identity, usage } from './fixtures.js'

const tokenEvents = (text: string): ProviderEvent[] =>
  Array.from({ length: text.length }, (_, index) => ({ type: 'token', text: text[index]! }))

it('模型增量按块提交：正文不丢字、增量载荷可拼接、事件数量远小于增量数', async () => {
  const text = '合成流式正文'.repeat(100)
  const rounds: ProviderEvent[][] = [[
    ...tokenEvents(text),
    { type: 'usage', usage },
    { type: 'complete', text, calls: [] },
  ]]
  const { harness } = fixture(rounds)
  const { events, state } = await collect(harness.start(identity))
  expect(state.text).toBe(text)
  const committed = events.filter(event => event.type === 'token')
  expect(committed.length).toBeGreaterThan(0)
  // 分块提交后事件数量必须远少于增量数量，否则存储又会退回逐条落库。
  expect(committed.length).toBeLessThan(text.length / 10)
  expect(committed.map(event => String(event.payload.text ?? '')).join('')).toBe(text)
})

it('展示项按同一气泡覆盖且始终是累积全文，界面不会只剩最后一块', async () => {
  const text = '合成气泡正文'.repeat(80)
  const rounds: ProviderEvent[][] = [[
    ...tokenEvents(text),
    { type: 'complete', text, calls: [] },
  ]]
  const { harness } = fixture(rounds)
  const { events } = await collect(harness.start(identity))
  const displays = events
    .filter(event => event.type === 'token')
    .map(event => (event.payload.display as { text?: string } | undefined)?.text ?? '')
  expect(displays.length).toBeGreaterThan(0)
  expect(displays.at(-1)).toBe(text)
  for (const value of displays) expect(text.startsWith(value)).toBe(true)
})

it('Provider 中途报错时已展示的正文不随运行失败一起丢失', async () => {
  const text = '合成中断正文'.repeat(50)
  const rounds: ProviderEvent[][] = [[
    ...tokenEvents(text),
    { type: 'error', error: new Error('合成上游中断') },
  ]]
  const { harness, records, idKey } = fixture(rounds)
  const { state } = await collect(harness.start(identity))
  expect(state.status).toBe('failed')
  // 运行失败会把正文改写成错误文案，用户实际看到的是展示气泡，气泡不能少字。
  const assistant = records.get(idKey(identity))?.displayTimeline.find(item => item.kind === 'assistant')
  expect(assistant?.text).toBe(text)
})
