import { describe, expect, it } from 'vitest'
import { tokenCatalog } from './tokenCatalog'

describe('设计令牌目录契约', () => {
  it('间距、字号、圆角各自只保留四个主档位', () => {
    expect(tokenCatalog.filter(token => token.variable.startsWith('--space-'))).toHaveLength(4)
    expect(tokenCatalog.filter(token => token.variable.startsWith('--font-size-'))).toHaveLength(4)
    expect(tokenCatalog.filter(token => token.variable.startsWith('--radius-') && token.variable !== '--radius-pill')).toHaveLength(4)
  })

  it('目录只保存展示元数据，不复制令牌实际值', () => {
    expect(tokenCatalog.every(token => !('value' in token))).toBe(true)
    expect(new Set(tokenCatalog.map(token => token.variable)).size).toBe(tokenCatalog.length)
  })
})
