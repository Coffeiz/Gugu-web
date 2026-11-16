import assert from 'node:assert/strict'
import test from 'node:test'
import { renderCharts } from '../src/render.mjs'

test('package renderer returns PNG frames for Mermaid and TeX in request order', async () => {
  const result = await renderCharts({ charts: [
    { type: 'mermaid', source: 'flowchart LR; A --> B' },
    { type: 'math', source: String.raw`x^2 + y^2` },
  ] })
  assert.equal(result.length, 2)
  for (const image of result) {
    assert.ok(Buffer.isBuffer(image))
    assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
})

test('package renderer rejects requests outside the documented chart limits', async () => {
  await assert.rejects(renderCharts({ charts: Array.from({ length: 5 }, () => ({ type: 'math', source: 'x' })) }), RangeError)
  await assert.rejects(renderCharts({ charts: [{ type: 'mermaid', source: 'x'.repeat(20_001) }] }), RangeError)
  await assert.rejects(renderCharts({ charts: [{ type: 'unknown', source: 'x' }] }), TypeError)
  assert.deepEqual(await renderCharts({ charts: [] }), [])
})

test('package renderer propagates cancellation without returning a partial frame', async () => {
  const controller = new AbortController()
  const pending = renderCharts({ charts: [{ type: 'math', source: 'x'.repeat(10_000) }] }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
