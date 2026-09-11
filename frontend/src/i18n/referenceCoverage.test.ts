import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { messages } from './messages'

/**
 * 引用覆盖守卫：源码里 `t('scope.key')` 的静态引用必须在三个语言包都能取到文案。
 *
 * 为什么需要它：语言包是按 scope 分块 `Object.assign` 拼出来的，如果同一个 scope
 * 被赋值两次（历史上 llmExtraUi 就有过一个残留的旧块跑在后面），后一次会整体替换
 * 前一次的键，中文/日文/英文同时丢键——编译和类型检查都不报错，运行时用户直接看到
 * `scope.key` 字面量。这里以「用户能否取到文案」为准做一次端到端校验。
 */
const srcRoot = resolve(process.cwd(), 'src')
const LOCALES = ['zh-CN', 'ja-JP', 'en-US'] as const

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    // 测试文件里的 t('scope.key') 是断言用的样例字符串，不代表产品 UI 引用
    else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path)
  }
  return out
}

function resolveMessage(locale: string, path: string): unknown {
  let node: unknown = (messages as Record<string, unknown>)[locale]
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

describe('i18n 引用覆盖', () => {
  it('源码里的静态 t() 引用在三个语言包中都有对应文案', () => {
    const missing: string[] = []
    for (const file of walk(srcRoot)) {
      const source = readFileSync(file, 'utf8')
      const refs = new Set<string>()
      for (const match of source.matchAll(/\b\$?t\(\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g)) {
        refs.add(match[1])
      }
      for (const key of refs) {
        for (const locale of LOCALES) {
          if (typeof resolveMessage(locale, key) !== 'string') {
            missing.push(`${relative(resolve(srcRoot, '..'), file)} -> ${locale}:${key}`)
          }
        }
      }
    }
    expect(missing).toEqual([])
  }, 60_000)
})
