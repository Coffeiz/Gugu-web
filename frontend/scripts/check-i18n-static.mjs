#!/usr/bin/env node
/**
 * 检查生产 Vue 模板中的固定中文 UI 文案。
 * 注释、script/style、表达式和 Design/Dev 演示页不属于业务 UI 扫描范围。
 */
import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname, 'src')
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
const chinese = /[一-龥]/
const violations = []

for (const file of files) {
  if (excluded.test(file)) continue
  const source = await readFile(file, 'utf8')
  // 先移除 HTML 注释再提取模板，避免注释中的示例 template 标签提前截断真实模板。
  const sourceWithoutComments = source.replace(/<!--[\s\S]*?-->/g, '')
  const template = sourceWithoutComments.match(/<template(?:\s[^>]*)?>([\s\S]*)<\/template>/)?.[1] ?? ''
  const clean = template
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
  const lines = []
  let disabledDepth = 0
  for (const line of clean.split('\n')) {
    if (disabledDepth > 0) {
      disabledDepth += (line.match(/<div\b/g) ?? []).length
      disabledDepth -= (line.match(/<\/div>/g) ?? []).length
      continue
    }
    if (/\bv-if=["']false["']/.test(line)) {
      disabledDepth = (line.match(/<div\b/g) ?? []).length - (line.match(/<\/div>/g) ?? []).length
      continue
    }
    lines.push(line)
  }
  lines.forEach((line, index) => {
    const text = line.replace(/<[^>]+>/g, '').trim()
    if (text && chinese.test(text)) violations.push(`${relative(resolve(root, '..'), file)}:${index + 1}: ${text}`)
    const attrs = line.match(/(?:title|placeholder|aria-label)="([^"]*[一-龥][^"]*)"/g) ?? []
    attrs.filter(attr => !/[{}?`]/.test(attr)).forEach(attr => violations.push(`${relative(resolve(root, '..'), file)}:${index + 1}: ${attr}`))
  })
}

if (violations.length) {
  console.error(`发现 ${violations.length} 处疑似固定 UI 文案：`)
  console.error(violations.join('\n'))
  process.exitCode = 1
} else {
  console.log('i18n 静态扫描通过')
}
