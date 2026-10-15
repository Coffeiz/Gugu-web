import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import { normalizeMermaidDatabaseLabelPosition } from '../svg-style.mjs'

const workerPath = fileURLToPath(new URL('../worker.mjs', import.meta.url))

test('IM 光栅化时数据库节点标签应回到圆柱中心', () => {
  const document = new DOMParser().parseFromString(
    '<svg><g class="node default"><path class="basic label-container outer-path"/>' +
    '<g class="label" transform="translate(-60, -1)"><text><tspan>TablesDB</tspan></text></g></g>' +
    '<g class="node default"><rect class="basic label-container"/>' +
    '<g class="label" transform="translate(0, -10)"><text>普通节点</text></g></g>' +
    '<g class="edgeLabel"><text>关系</text></g></svg>',
    'image/svg+xml',
  )

  normalizeMermaidDatabaseLabelPosition(document.documentElement)

  assert.equal(
    document.getElementsByTagName('text')[0].getAttribute('text-anchor'),
    'middle',
    '圆柱内文字应以节点中心为水平锚点',
  )
  assert.equal(
    document.getElementsByTagName('g')[1].getAttribute('transform'),
    'translate(0, -1)',
    '数据库节点的半标签宽度偏移应移除并保留垂直布局',
  )
  assert.equal(
    document.getElementsByTagName('g')[3].getAttribute('transform'),
    'translate(0, -10)',
    '普通流程节点的标签布局应保持原样',
  )
  assert.equal(
    document.getElementsByTagName('text')[2].hasAttribute('text-anchor'),
    false,
    '连线标签不应被数据库节点修正影响',
  )
})

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
