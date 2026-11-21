import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createChartRenderer, renderCharts } from '../src/render.mjs'

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

test('常驻 Worker 切换主题和公式后，复用渲染与冷启动输出一致', async () => {
  const diagram = { type: 'mermaid', source: 'flowchart LR; A[开始] --> B[完成]' }
  const render = createChartRenderer()
  const [light] = await render({ charts: [diagram], theme: { theme: 'light' } })
  const [dark] = await render({ charts: [diagram], theme: { theme: 'dark', palette: 'blue' } })
  const [math] = await render({ charts: [{ type: 'math', source: 'x^2 + y^2' }] })
  const [lightAgain] = await render({ charts: [diagram], theme: { theme: 'light' } })
  assert.ok(Buffer.isBuffer(math))
  assert.notDeepEqual(dark, light)
  assert.deepEqual(lightAgain, light)
  const [coldDark] = await createChartRenderer()({ charts: [diagram], theme: { theme: 'dark', palette: 'blue' } })
  assert.deepEqual(dark, coldDark)
})

test('空闲、张数、RSS 和超时回收从新进程续接，当前图片不丢失', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-chart-lifecycle-'))
  try {
    const path = join(dir, 'worker.cjs')
    await writeFile(path, `
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const source = JSON.parse(line).charts[0].source
        if (source === 'timeout') return
        if (source === 'invalid') { process.stdout.write(Buffer.alloc(8)); return }
        const png = Buffer.alloc(12)
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
        png.writeUInt32BE(process.pid, 8)
        const header = Buffer.alloc(8)
        header.writeUInt32BE(png.length)
        header.writeUInt32BE(source === 'high-rss' ? 350 * 1024 ** 2 : 100 * 1024 ** 2, 4)
        process.stdout.write(Buffer.concat([header, png]))
      })
    `)
    const render = createChartRenderer({ path, maxCharts: 2, idleMs: 50, timeoutMs: 1000 })
    const request = (...sources) => ({ charts: sources.map(source => ({ type: 'mermaid', source })) })
    const pid = async source => (await render(request(source)))[0].readUInt32BE(8)
    const batch = (await render(request('one', 'two', 'three'))).map(png => png.readUInt32BE(8))
    assert.equal(batch[0], batch[1])
    assert.notEqual(batch[1], batch[2])
    assert.equal(await pid('high-rss'), batch[2])
    const beforeIdle = await pid('one')
    assert.notEqual(beforeIdle, batch[2])
    await sleep(100)
    const afterIdle = await pid('one')
    assert.notEqual(afterIdle, beforeIdle)
    await assert.rejects(render(request('timeout')), { code: 'render_timeout' })
    const afterTimeout = await pid('one')
    assert.notEqual(afterTimeout, afterIdle)
    await assert.rejects(render(request('invalid')), { code: 'invalid_worker_frame' })
    assert.notEqual(await pid('one'), afterTimeout)
    // RSS 回收应独立于张数回收。
    const byRss = createChartRenderer({ path, idleMs: 50 })
    const rssBatch = await byRss(request('high-rss', 'one'))
    assert.notEqual(rssBatch[0].readUInt32BE(8), rssBatch[1].readUInt32BE(8))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
