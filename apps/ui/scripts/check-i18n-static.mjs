#!/usr/bin/env node
/**
 * 检查生产 Vue 模板中的固定中文 UI 文案及绑定表达式。
 * 注释、script/style 和 Design/Dev 演示页不属于模板扫描范围。
 */
import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'vue/compiler-sfc'

// URL.pathname 会把中文目录编码成 %E6...，在 devserver 等非 ASCII 路径下会导致扫描目录不存在。
const root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'src')
async function findVueFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? findVueFiles(path) : entry.isFile() && entry.name.endsWith('.vue') ? [path] : []
  }))
  return nested.flat()
}
const files = await findVueFiles(root)
const excluded = /(?:^|[\\/])views[\\/](?:Design|DevHome\.vue$|DevOnboarding\.vue$)/
const chinese = /[\p{Script=Han}]/u
const labels = new Set(['title', 'placeholder', 'aria-label', 'description', 'label', 'alt'])
const violations = []

for (const file of files) {
  if (excluded.test(file)) continue
  const { descriptor, errors } = parse(await readFile(file, 'utf8'), { filename: file })
  const location = relative(resolve(root, '..'), file)
  for (const error of errors) {
    violations.push(`${location}: ${typeof error === 'string' ? error : error.message}`)
  }
  const ast = descriptor.template?.ast
  if (!ast) continue
  const add = (value, loc) => {
    if (value && chinese.test(value)) violations.push(`${location}:${loc.start.line}: ${value.trim()}`)
  }
  function visit(node) {
    if (node.props?.some(prop => prop.type === 7 && prop.name === 'if' && prop.exp?.content === 'false')) return
    if (node.type === 2) add(node.content, node.loc)
    if (node.type === 5) add(node.content.content, node.loc)
    for (const prop of node.props ?? []) {
      if (prop.type === 6 && labels.has(prop.name)) add(prop.value?.content, prop.loc)
      if (prop.type === 7) add(prop.exp?.content, prop.loc)
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(ast)
}

if (violations.length) {
  console.error(`发现 ${violations.length} 处疑似固定 UI 文案：`)
  console.error(violations.join('\n'))
  process.exitCode = 1
} else {
  console.log('i18n 静态扫描通过')
}
