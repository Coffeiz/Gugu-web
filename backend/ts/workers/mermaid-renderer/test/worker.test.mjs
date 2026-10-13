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
  assert.deepEqual(result.stdout.subarray(4, 12), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.doesNotMatch(result.stderr.toString('utf8'), /MERMAID_RENDER_FAILURE/)
})
