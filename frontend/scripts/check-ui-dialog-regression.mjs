import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const sourceRoot = resolve(process.argv[2] || 'src')
const extensions = new Set(['.vue', '.ts', '.tsx', '.js', '.mjs'])
const files = []

function walk(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (extensions.has(path.slice(path.lastIndexOf('.'))) && !/\.(test|spec)\./.test(path)) files.push(path)
  }
}

walk(sourceRoot)

const nativeDialog = /\b(?:window|globalThis)\s*\.\s*(?:alert|confirm|prompt)\s*\(/g
const violations = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  if (nativeDialog.test(source)) violations.push(file)
  nativeDialog.lastIndex = 0
}

const byokPath = join(sourceRoot, 'components/common/ProfileModal/ProfileByokPane.vue')
const byokSource = readFileSync(byokPath, 'utf8')
const requiredByokContracts = [
  'confirmDialog(',
  "profileByokUi.deleteTitle",
  "profileByokUi.deleteMessage",
  "profileByokUi.deleteConfirm",
  "gugu-quota-changed",
]
const missingContracts = requiredByokContracts.filter(contract => !byokSource.includes(contract))

const projectActionsPath = join(sourceRoot, 'composables/projects/useProjectModalActions.ts')
const projectActionsSource = readFileSync(projectActionsPath, 'utf8')
const requiredProjectContracts = [
  'confirmDialog(',
  "projects.deleteTitle",
  "projects.deleteMessage",
  'projectStore.deleteProject',
]
const missingProjectContracts = requiredProjectContracts.filter(contract => !projectActionsSource.includes(contract))

if (violations.length || missingContracts.length || missingProjectContracts.length) {
  if (violations.length) {
    console.error('[提醒组件回归] 禁止在生产 UI 源码中直接调用浏览器原生 alert/confirm/prompt：')
    for (const file of violations) console.error(`- ${file}`)
  }
  if (missingContracts.length) {
    console.error(`[提醒组件回归] BYOK 删除模型缺少统一确认契约：${missingContracts.join(', ')}`)
  }
  if (missingProjectContracts.length) {
    console.error(`[提醒组件回归] 项目删除缺少统一确认契约：${missingProjectContracts.join(', ')}`)
  }
  process.exit(1)
}

console.log(`[提醒组件回归] 通过：已检查 ${files.length} 个 UI 源文件，BYOK 与项目删除确认契约完整。`)
