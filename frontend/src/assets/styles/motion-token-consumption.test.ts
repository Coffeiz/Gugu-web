import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 组合型 transition 令牌（值里自带属性名，如 `--card-overlay-motion: opacity 250ms ease`）
 * 只能整体消费：`transition: var(--card-overlay-motion)`。
 * 写成 `transition: opacity var(--card-overlay-motion)` 会展开成
 * `opacity opacity 250ms ease`，属性名重复使整条声明非法被丢弃，hover 反而瞬间跳变而不会淡入。
 * 这类错误不报错、只在肉眼上表现为「没有过渡」，所以在这里静态拦截。
 */
const SRC_ROOT = resolve(process.cwd(), 'src')

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(css|vue)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 收集全部 token 定义；同名 token 取第一个定义（主题覆盖只是换值，不影响「以属性名开头」的判定）。 */
function collectTokens(sources: string[]) {
  const tokens = new Map<string, string>()
  for (const source of sources) {
    for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
      if (!tokens.has(match[1])) tokens.set(match[1], match[2].trim())
    }
  }
  return tokens
}

const files = walk(SRC_ROOT)
const contents = new Map(files.map(file => [file, readFileSync(file, 'utf8')]))
const tokens = collectTokens([...contents.values()])

const violations: string[] = []
for (const [file, raw] of contents) {
  const styleSources = file.endsWith('.vue')
    ? [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1])
    : [raw]
  for (const source of styleSources) {
    for (const match of source.matchAll(/transition\s*:\s*([^;{}]+)[;}]/g)) {
      for (const part of match[1].split(',')) {
        const misuse = part.match(/^\s*([a-z-]+)\s+var\((--[\w-]+)\)/)
        if (!misuse) continue
        const [, property, token] = misuse
        const value = tokens.get(token)
        if (value && new RegExp(`^${property}\\b`).test(value)) {
          violations.push(`${file.replace(`${SRC_ROOT}/`, '')}: transition: ${property} var(${token})（该令牌为「${value}」）`)
        }
      }
    }
  }
}

describe('transition 令牌消费契约', () => {
  it('组合型 motion 令牌整体消费，不重复书写属性名', () => {
    expect(violations).toEqual([])
  })
})
