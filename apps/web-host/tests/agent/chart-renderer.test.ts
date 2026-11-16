import assert from 'node:assert/strict'
import test from 'node:test'
import { renderAgentCharts } from '../../src/modules/agent/chart-renderer.js'

test('Node Host 经 charts 包渲染 Mermaid 与 Math PNG，保留输入数量限制', async () => {
  const images = await renderAgentCharts({ charts: [
    { type: 'mermaid', source: 'flowchart LR; A[开始] --> B[完成]' },
    { type: 'math', source: String.raw`\frac{a}{b}` },
  ] })
  assert.equal(images.length, 2)
  for (const image of images) {
    assert.ok(Buffer.isBuffer(image))
    assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }

  await assert.rejects(
    renderAgentCharts({ charts: Array.from({ length: 5 }, () => ({ type: 'math' as const, source: 'x' })) }),
    /图表数量超过限制/,
  )
})

test('Node Host 取消渲染时终止隔离 worker', async () => {
  const controller = new AbortController()
  const pending = renderAgentCharts({ charts: [{ type: 'math', source: 'x'.repeat(10_000) }] }, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
