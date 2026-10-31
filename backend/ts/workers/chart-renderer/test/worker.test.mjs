import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import {
  normalizeMermaidDatabaseLabelPosition,
  normalizeMermaidEdgeLabelBounds,
  normalizeMermaidRasterText,
} from '../svg-style.mjs'
import { calculateMermaidRasterDimensions } from '../raster-dimensions.mjs'

const workerPath = fileURLToPath(new URL('../worker.mjs', import.meta.url))

test('IM 光栅化时数据库节点标签应回到圆柱中心', () => {
  const document = new DOMParser().parseFromString(
    '<svg><g class="node default"><path class="basic label-container outer-path"/>' +
    '<g class="label" transform="translate(-60, -1)"><text>' +
    '<tspan y="0">Tables</tspan><tspan dy="1em">Example</tspan><tspan dy="1em">DB</tspan>' +
    '</text></g></g>' +
    '<g class="node default"><rect class="basic label-container"/>' +
    '<g class="label" transform="translate(0, -10)"><text>普通节点</text></g></g>' +
    '<g class="edgeLabel"><text>关系</text></g></svg>',
    'image/svg+xml',
  )

  normalizeMermaidDatabaseLabelPosition(document.documentElement, { rasterizer: true })

  assert.equal(
    document.getElementsByTagName('text')[0].getAttribute('text-anchor'),
    'middle',
    '圆柱内文字应以节点中心为水平锚点',
  )
  assert.equal(
    document.getElementsByTagName('g')[1].getAttribute('transform'),
    'translate(0, -22)',
    'PNG 光栅化时应按额外文本行数校正数据库标签垂直偏移',
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

test('源 SVG 像素超过预算时应缩放到预算内而不是拒绝渲染', () => {
  const dimensions = calculateMermaidRasterDimensions(4_000, 2_000)

  assert.deepEqual(dimensions, { width: 3_162, height: 1_581 })
  assert.ok(dimensions.width * dimensions.height <= 5_000_000)
})

test('大尺寸 block-beta 图超过未缩放像素预算后仍应生成预算内 PNG', () => {
  const side = 16
  const rows = Array.from({ length: side }, (_, row) =>
    Array.from({ length: side }, (_, column) => `n${row}_${column}["标题<br/>说明"]`).join(' '),
  )
  const source = ['block-beta', `  columns ${side}`, ...rows.map(row => `  ${row}`)].join('\n')
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

  assert.equal(result.error, undefined, '大图应在渲染时限内完成')
  assert.equal(result.status, 0, '大图光栅化进程应正常结束')
  const imageSize = result.stdout.readUInt32BE(0)
  const png = result.stdout.subarray(4, 4 + imageSize)
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.ok(width * height > 4_900_000, '大图应利用像素预算生成高分辨率 PNG')
  assert.ok(width * height <= 5_000_000, '缩放后的 PNG 不得超过像素预算')
  assert.doesNotMatch(result.stderr.toString('utf8'), /MERMAID_RENDER_FAILURE/)
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

test('IM 光栅化时多行中文边标签应比单行标签额外上移以保持垂直居中', () => {
  const document = new DOMParser().parseFromString(
    '<svg><g class="edgeLabel"><text font-size="16" transform="translate(0, -2)">' +
    '<tspan x="0" y="-0.1em" dy="1.1em">union estimate +</tspan>' +
    '<tspan x="0" y="1em" dy="1.1em">加权凸聚类</tspan></text></g>' +
    '<g class="edgeLabel"><text font-size="16"><tspan>Lemma 2.15 输入</tspan></text></g></svg>',
    'image/svg+xml',
  )

  normalizeMermaidRasterText(document.documentElement, '#333333')

  const labels = document.getElementsByTagName('text')
  assert.equal(
    labels[0].getAttribute('transform'),
    'translate(0 -19.20) translate(0, -2)',
    '多行中文边标签应额外上移，保留既有 Mermaid 变换',
  )
  assert.equal(
    labels[1].getAttribute('transform'),
    'translate(0 -14.40)',
    '单行中文边标签应保持原有基线校正',
  )
})

test('IM 光栅化应把越出 SVG 边界的曲线连线标签纳入 viewBox', () => {
  const document = new DOMParser().parseFromString(
    '<svg viewBox="-8 -8 374.457 759.455"><g class="edgeLabel" transform="translate(75.728, 471.354)">' +
    '<g class="label" transform="translate(-37.756, 5.207)"><rect class="background" x="-67.728" y="-18.102" width="135.457" height="25.789"/>' +
    '<text x="0" text-anchor="middle"><tspan>Lemma 2.15 输入</tspan></text></g></g></svg>',
    'image/svg+xml',
  )

  normalizeMermaidEdgeLabelBounds(document.documentElement)

  const [minX, , width] = document.documentElement.getAttribute('viewBox').split(/\s+/).map(Number)
  assert.ok(minX <= -31.75, 'viewBox 左边界应覆盖标签背景及描边留白')
  assert.ok(minX + width >= 366.457, '扩展左边界时应保留原始 SVG 右边界')
})

test('用户提供的纵向流程图在 IM 光栅化后应完整容纳左侧连线标签', () => {
  const source = [
    'flowchart TD',
    '  WZ["王虹 + Zahl（2022→2025）<br/>三维集合版：sticky → Assouad → Hausdorff/Minkowski 全维"]',
    '  GWZ["Guth + Wang + Zahl<br/>三维证明的精简版"]',
    '  OAI3["OpenAI 三维稿（2026-09-23）<br/>极大函数版：把密度损失从 δ^α 补成 δ^α³"]',
    '  OAI4["OpenAI 四维稿（2026-09-24）<br/>四维集合版：dim_H K = 4，无紧致性假设"]',
    '',
    '  WZ --> GWZ -->|"Lemma 2.15 输入"| OAI4',
    '  GWZ -->|"union estimate + 加权凸聚类"| OAI3',
    '  OAI3 --> OAI4',
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

  assert.equal(result.error, undefined, '纵向流程图应在渲染时限内完成')
  assert.equal(result.status, 0, '纵向流程图光栅化进程应正常结束')
  const imageSize = result.stdout.readUInt32BE(0)
  const png = result.stdout.subarray(4, 4 + imageSize)
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.ok(png.readUInt32BE(16) > 750, 'PNG 宽度应包含原本越出左边界的连线标签')
  assert.doesNotMatch(result.stderr.toString('utf8'), /MERMAID_RENDER_FAILURE/)
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
