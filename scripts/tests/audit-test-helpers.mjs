#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const root = path.resolve(import.meta.dirname, '../..')
const testsRoot = path.join(root, 'backend/tests')
const outputPath = path.join(root, 'docs/reports/2026-08-31-TEST-HELPER-AUDIT.md')

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(full)
    return entry.name.startsWith('test_') && entry.name.endsWith('.py') ? [full] : []
  })
}

const records = []
const functionRecords = []
for (const file of filesUnder(testsRoot)) {
  const source = fs.readFileSync(file, 'utf8')
  const relative = path.relative(root, file)
  for (const match of source.matchAll(/^class\s+(_?Fake[A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*:/gm)) {
    const className = match[1]
    const start = match.index + match[0].length
    const nextTopLevel = source.slice(start).search(/^(?:class\s+|(?:async\s+)?def\s+)/m)
    const body = source.slice(start, nextTopLevel < 0 ? source.length : start + nextTopLevel)
    const methods = [...body.matchAll(/^\s+(?:async\s+)?def\s+([A-Za-z0-9_]+)/gm)].map(item => item[1])
    records.push({ file: relative, name: className, methods: [...new Set(methods)] })
  }
  const lines = source.split('\n')
  for (const match of source.matchAll(/^(\s+)(?:async\s+)?def\s+((?:fake|make|build|create|seed|assert|render|normalize|parse)_[A-Za-z0-9_]+)\s*\(([^\n]*)/gm)) {
    const lineIndex = source.slice(0, match.index).split('\n').length - 1
    const baseIndent = match[1].length
    const bodyLines = []
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() && line.match(/^\s*/)[0].length <= baseIndent) break
      bodyLines.push(line)
    }
    const normalizedBody = bodyLines.map(line => line.trim()).filter(Boolean).join('\n')
    functionRecords.push({
      file: relative,
      name: match[2],
      signature: `${match[2]}(${match[3]}`,
      bodyHash: normalizedBody ? crypto.createHash('sha1').update(normalizedBody).digest('hex') : null,
    })
  }
}

const groups = new Map()
for (const record of records) {
  if (!groups.has(record.name)) groups.set(record.name, [])
  groups.get(record.name).push(record)
}
const functionGroups = new Map()
for (const record of functionRecords) {
  if (!functionGroups.has(record.name)) functionGroups.set(record.name, [])
  functionGroups.get(record.name).push(record)
}

const assessments = {
  _FakeLock: '四处语义不同：附件清理/快照是可配置的非阻塞锁，session gate 记录 acquired 状态，视频缓存包装真实 asyncio.Lock；保留原地。',
  _FakeRedis: '方法集合覆盖缓存、锁、集合、过期或脚本执行等不同边界；同名不代表同一 Redis 契约，保留原地。',
  FakeRedis: '分别模拟迁移扫描、一次性绑定码和 QQ 连接发布，状态模型及生产入口不同，保留原地。',
  _FakeClient: '分别模拟搜索 HTTP、文件流式请求和 provider stream 客户端，响应协议与错误边界不同，保留原地。',
  _FakeResponse: '分别服务媒体分块读取和搜索 JSON 响应，接口形状不同，保留原地。',
}

const lines = [
  '# 测试 Fixture 与构造器审查',
  '',
  '> 由 `scripts/tests/audit-test-helpers.mjs` 扫描 `backend/tests` 生成。该报告只登记重复候选，不自动改写测试。',
  '',
  '## 处置规则',
  '',
  '- 只有在模拟对象的方法集合、状态语义和调用边界都一致时，才允许抽到 `conftest.py` 或共享 helper。',
  '- 领域专用 fake 即使同名，也保留在原测试文件，避免公共 fake 通过额外方法掩盖生产契约。',
  '- fixture 抽取必须先运行受影响领域专项、`test:fast` 和后端全量测试。',
  '',
  '## 重复候选',
  '',
]

for (const [name, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`### ${name}`, '', `出现文件：${items.length}`, '')
  for (const item of items) lines.push(`- \`${item.file}\`：${item.methods.length ? item.methods.join(', ') : '无方法'}`)
  lines.push('')
  if (items.length > 1) lines.push(`处置：${assessments[name] ?? '暂不抽取；需要逐个对拍状态语义和生产调用边界。'}`, '')
  else lines.push('处置：单文件专用，保留原地。', '')
}

lines.push('## 当前结论', '', '- `_FakeRedis` 等同名模拟对象的方法集合不同，不能合并为万能 fixture。', '- 后续优先抽取无行为的构造器参数和断言辅助函数；本轮不移动、不删除业务测试。')
lines.push('', '## 重复函数名（不等于重复实现）', '', '> 仅列出跨文件出现的 helper 名称；同一文件内针对不同场景的局部 fake 不列入候选。')
for (const [name, items] of [...functionGroups].filter(([, values]) => new Set(values.map(item => item.file)).size > 1).sort((a, b) => b[1].length - a[1].length)) {
  lines.push('', `### ${name}`, '')
  for (const item of items) lines.push(`- \`${item.file}\`：\`${item.signature}\``)
  lines.push('处置：仅名称重复，暂不抽取；需在后续对拍函数体和断言语义。')
}
const bodyGroups = new Map()
for (const record of functionRecords.filter(record => record.bodyHash)) {
  if (!bodyGroups.has(record.bodyHash)) bodyGroups.set(record.bodyHash, [])
  bodyGroups.get(record.bodyHash).push(record)
}
const exactBodies = [...bodyGroups.values()].filter(items => new Set(items.map(item => item.file)).size > 1)
lines.push('', '## 跨文件完全重复函数体', '', '> 仅列出函数体归一化后完全一致且跨文件出现的 helper；没有结果时表示本轮未找到可直接抽取的重复实现。', '')
if (!exactBodies.length) {
  lines.push('- 未发现跨文件完全重复函数体。')
} else {
  for (const items of exactBodies) {
    lines.push(`- ${items.map(item => `\`${item.file}\` 的 \`${item.name}\``).join('、')}：候选抽取，仍需人工确认 fixture 依赖。`)
  }
}
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`)
console.log(`已生成 ${path.relative(root, outputPath)}，记录 ${records.length} 个 helper。`)
