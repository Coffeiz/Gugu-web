import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const workerPath = fileURLToPath(new URL('../worker.mjs', import.meta.url))

test('中文 Sankey 能通过图片渲染器输出 PNG', () => {
  const source = [
    'sankey',
    '  网页,直接渲染,30',
    '  QQ,直接渲染,20',
    '  QQ,返回代码块,5',
  ].join('\n')
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=256', workerPath],
    {
      input: JSON.stringify({ sources: [source] }),
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 20_000,
    },
  )

  assert.equal(result.error, undefined, '图片渲染进程应正常结束')
  assert.equal(result.status, 0, '图片渲染进程应返回成功')
  assert.ok(result.stdout.length >= 12, '结果应包含 PNG 帧头和图片数据')
  const imageSize = result.stdout.readUInt32BE(0)
  assert.ok(imageSize > 8, 'Sankey 应渲染出非空图片')
  const png = result.stdout.subarray(4, 4 + imageSize)
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(png.readUInt32BE(16), 1_200, 'Sankey 应保持原 SVG 宽度的 2×栅格输出')
  assert.equal(png.readUInt32BE(20), 800, 'Sankey 应保持原 SVG 高度的 2×栅格输出')
  assert.doesNotMatch(result.stderr.toString('utf8'), /MERMAID_RENDER_FAILURE/)
})

test('block-beta 能通过服务端 SVG DOM 渲染出 PNG', () => {
  const source = [
    'block-beta',
    '  columns 3',
    '  a["需求"] b["草稿"] c["正稿"]',
    '  d["修改"] e["结款"] f["归档"]',
  ].join('\n')
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=256', workerPath],
    {
      input: JSON.stringify({ sources: [source] }),
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 20_000,
    },
  )

  assert.equal(result.error, undefined, '图片渲染进程应正常结束')
  assert.equal(result.status, 0, '图片渲染进程应返回成功')
  assert.ok(result.stdout.length >= 12, '结果应包含 PNG 帧头和图片数据')
  const imageSize = result.stdout.readUInt32BE(0)
  assert.ok(imageSize > 8, 'block-beta 应渲染出非空图片')
  assert.deepEqual(result.stdout.subarray(4, 12), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.doesNotMatch(result.stderr.toString('utf8'), /MERMAID_RENDER_FAILURE/)
})
