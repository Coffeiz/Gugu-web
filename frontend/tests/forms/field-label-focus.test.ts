import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

type TemplateAttribute = {
  type: number
  name: string
  value?: { content: string } | null
}

type TemplateNode = {
  type: number
  tag?: string
  props?: TemplateAttribute[]
  children?: TemplateNode[]
}

const sourceRoot = join(process.cwd(), 'src')
const nonTextInputTypes = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden'])
const frontendRequire = createRequire(join(process.cwd(), 'package.json'))
const pluginVueEntry = frontendRequire.resolve('@vitejs/plugin-vue')
const pluginVueRequire = createRequire(pluginVueEntry)
const { parse } = pluginVueRequire(pluginVueRequire.resolve('@vue/compiler-sfc')) as {
  parse: (source: string, options: { filename: string }) => {
    descriptor: { template?: { ast?: TemplateNode } }
    errors: unknown[]
  }
}

function listVueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listVueFiles(path)
    return entry.isFile() && entry.name.endsWith('.vue') ? [path] : []
  })
}

function staticAttribute(node: TemplateNode, name: string): string | undefined {
  const attr = node.props?.find(prop => prop.type === 6 && prop.name === name)
  return attr?.value?.content
}

function isTextEntryControl(node: TemplateNode): boolean {
  if (node.type !== 1) return false
  if (node.tag === 'textarea' || node.tag === 'select') return true
  if (node.tag !== 'input') return false
  return !nonTextInputTypes.has((staticAttribute(node, 'type') || 'text').toLowerCase())
}

function descendants(node: TemplateNode): TemplateNode[] {
  return (node.children || []).flatMap(child => [child, ...descendants(child)])
}

function findViolations(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const { descriptor, errors } = parse(source, { filename: file })
  if (errors.length || !descriptor.template?.ast) {
    return [`${relative(sourceRoot, file)}: 模板无法解析，无法验证标题聚焦规范`]
  }

  const root = descriptor.template.ast as unknown as TemplateNode
  const nodes = [root, ...descendants(root)]
  const controlsById = new Map<string, TemplateNode[]>()
  for (const node of nodes) {
    if (!isTextEntryControl(node)) continue
    const id = staticAttribute(node, 'id')
    if (id) controlsById.set(id, [...(controlsById.get(id) || []), node])
  }

  const violations: string[] = []
  for (const node of nodes) {
    if (node.type !== 1 || node.tag !== 'label') continue
    const path = relative(sourceRoot, file)
    if (descendants(node).some(isTextEntryControl)) {
      violations.push(`${path}: <label> 包裹了文本输入控件`)
    }
    const targetId = staticAttribute(node, 'for')
    if (targetId && controlsById.has(targetId)) {
      violations.push(`${path}: <label for="${targetId}"> 会激活文本输入控件`)
    }
  }
  return violations
}

it('全站字段标题不通过 label 语义触发文本输入框聚焦', () => {
  const violations = listVueFiles(sourceRoot).flatMap(findViolations)
  expect(violations, `发现违反输入标题交互规范的 Vue 模板：\n${violations.join('\n')}`).toEqual([])
})
