import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import { normalizeMermaidDatabaseLabelPosition, normalizeMermaidEdgeLabelBounds } from '../svg-style.mjs'

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

test('IM 光栅化时英文连线标签底色应按文字宽度居中扩展', () => {
  const document = new DOMParser().parseFromString(
    '<svg><g class="edgeLabel"><rect class="labelBkg" x="-25" y="-10" width="50" height="20"/>' +
    '<text x="0" text-anchor="middle" font-size="16">A2A Task</text></g></svg>',
    'image/svg+xml',
  )

  normalizeMermaidEdgeLabelBounds(document.documentElement)

  const rect = document.getElementsByTagName('rect')[0]
  const expectedMinimumWidth = 16 * (0.6 * 7 + 0.33) + 4
  assert.ok(Number(rect.getAttribute('width')) >= expectedMinimumWidth)
  assert.ok(Math.abs(Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2) < 0.001)
  assert.equal(rect.getAttribute('rx'), '8')
  assert.equal(rect.getAttribute('ry'), '8')
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

test('用户自有端与 SaaS 跨子图连接时 A2A 图能生成完整 PNG', () => {
  const source = [
    'flowchart TB',
    '  subgraph anchor [SaaS 锚点]',
    '    mem[(记忆 · 项目 · 日程)]',
    '    reg[(设备注册表 · 在线状态)]',
    '    brain[常驻咕咕<br/>快速问答 · 任务调度]',
    '  end',
    '  subgraph edge [用户自有端]',
    '    d1[自部署咕咕]',
    '    d2[Desktop 咕咕]',
    '  end',
    '  phone[手机 · IM]',
    '  phone --> brain',
    '  brain -->|A2A Task| d1',
    '  brain -->|A2A Task| d2',
    '  d1 <-->|记忆同步| mem',
    '  d2 <-->|记忆同步| mem',
    '  d1 -.->|出站隧道 · 在线| reg',
    '  d2 -.->|出站隧道 · 在线| reg',
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

  assert.equal(result.error, undefined, 'A2A 图应在渲染时限内完成')
  assert.equal(result.status, 0, 'A2A 图光栅化进程应正常结束')
  const imageSize = result.stdout.readUInt32BE(0)
  assert.ok(imageSize > 8, 'A2A 图应生成非空 PNG')
  const png = result.stdout.subarray(4, 4 + imageSize)
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, 'PNG 应具有有效尺寸')
  assert.doesNotMatch(result.stderr.toString('utf8'), /MERMAID_RENDER_FAILURE/)
})
