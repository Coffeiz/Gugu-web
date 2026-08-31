import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const distRoot = resolve(process.argv[2] || 'dist')

function collectCss(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return collectCss(path)
    return entry.isFile() && path.endsWith('.css') ? [path] : []
  })
}

const files = collectCss(distRoot)
if (!files.length) {
  console.error(`[玻璃模糊回归] 未找到 CSS 构建产物：${distRoot}`)
  process.exit(1)
}

const css = files.map((file) => readFileSync(file, 'utf8')).join('\n')
const blocks = css.split('}')

// 这些是跨页面复用、且用户能直接感知的材质拥有者。业务组件通过
// .glass-card 或 .modal-mask 继承材质，不要求每个业务 class 重复声明 blur。
// 只检查非 none 的规则，避免 mono 模式的显式 none 规则掩盖 glass 规则缺失。
const contracts = [
  ['侧栏', '.sidebar'],
  ['咕咕聊天主体', '.chat-main'],
  ['通用玻璃卡片（画布/项目/工具栏）', '.glass-card'],
  ['通用弹窗遮罩（任务/项目/设置）', '.modal-mask'],
  ['弹出菜单', '.popup-menu'],
  ['富文本浮动工具栏', '.ne-toolbar-floating'],
]

const failures = []
for (const [name, selector] of contracts) {
  const match = blocks.some((block) => {
    if (!block.includes(selector) || !block.includes('backdrop-filter:')) return false
    const standard = block.match(/(?<!-)backdrop-filter:([^;}]+)/)?.[1]?.trim()
    const prefixed = block.match(/-webkit-backdrop-filter:([^;}]+)/)?.[1]?.trim()
    return Boolean(standard && prefixed && standard !== 'none' && prefixed !== 'none')
  })
  if (!match) failures.push(`${name} (${selector})`)
}

if (failures.length) {
  console.error('[玻璃模糊回归] 以下关键表面未同时保留标准与 WebKit blur 属性：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`[玻璃模糊回归] 通过：${files.length} 个 CSS 文件，${contracts.length} 个关键玻璃表面均保留双属性。`)
