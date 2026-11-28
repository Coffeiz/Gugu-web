import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { searchSnippet } from '../../../src/search/global-search.js'
import { lowerSearchText } from '@gugu/search'

interface Example { name: string; text: string; queries: string[]; expected: string }
const examples = JSON.parse(readFileSync(new URL('../../fixtures/search-snippet.json', import.meta.url), 'utf8')) as Example[]

describe('搜索片段沿用Python选择与截取契约', () => {
  for (const example of examples) it(example.name, () => {
    expect(searchSnippet(example.text, example.queries)).toBe(example.expected)
  })
  it('Unicode16全部标量lower和两侧尾sigma上下文符合独立Python摘要', () => {
    const hash = createHash('sha256')
    for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
      if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue
      const character = String.fromCodePoint(codepoint)
      hash.update(codepoint.toString(16) + ':' + lowerSearchText(character) + '\n'
        + lowerSearchText('A' + character + 'Σ') + '\n' + lowerSearchText('AΣ' + character + 'A') + '\n')
    }
    expect(hash.digest('hex')).toBe('675947c95ce0a49783f964cd9aa25e7815867bd170739f4b5887ee7ce2d29dc9')
  }, 15_000)
})
