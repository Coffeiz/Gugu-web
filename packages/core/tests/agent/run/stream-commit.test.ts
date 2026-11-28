import { expect, it } from 'vitest'
import type { ProviderEvent } from '../../../src/agent/models.js'
import { collect, deferred, fixture, identity, toolCall, usage } from './fixtures.js'

const tokenEvents = (text: string): ProviderEvent[] =>
  Array.from({ length: text.length }, (_, index) => ({ type: 'token', text: text[index]! }))

it('工具解析尚未返回时仍提交并结束这一轮的可见正文', async () => {
  const text = '合成正文。'
  const { harness, ports } = fixture([[{ type: 'token', text },
    { type: 'complete', text, calls: [{ ...toolCall, name: 'call_tool' }] }],
  [{ type: 'complete', text: '合成结果。', calls: [] }]])
  const resolveCall = deferred<{ call: typeof toolCall }>()
  const committed = deferred<string>()
  ports.tools.resolveCall = () => resolveCall.promise
  ports.publish = async event => { if (event.type === 'text_end') committed.resolve(String(event.payload.text)) }
  const run = collect(harness.start(identity))
  try { expect(await committed.promise).toBe(text) }
  finally { resolveCall.resolve({ call: toolCall }) }
  expect((await run).events.filter(event => event.type === 'text_end')).toHaveLength(1)
})

it('上游停顿时提交短文本，不等下一条 Provider 事件', { timeout: 1500 }, async () => {
  const { harness, ports } = fixture()
  const resume = deferred<void>()
  const committed = deferred<void>()
  ports.provider = { async *stream() {
    yield { type: 'token', text: '合成半句话' }
    await resume.promise
    yield { type: 'complete', text: '合成半句话', calls: [] }
  } }
  ports.publish = async event => { if (event.type === 'token') committed.resolve() }
  const run = collect(harness.start(identity))
  await committed.promise
  resume.resolve()
  expect((await run).state.status).toBe('completed')
})

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
