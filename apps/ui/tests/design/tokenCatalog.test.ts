// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { tokenCatalog } from '@/views/Design/data/tokenCatalog'

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

  it('全局复选框 paint 契约公开为标准组件令牌', () => {
    const checkboxTokens = tokenCatalog.filter(token => token.variable.startsWith('--control-checkbox-'))
    expect(checkboxTokens.map(token => token.variable)).toEqual(expect.arrayContaining([
      '--control-checkbox-size',
      '--control-checkbox-radius',
      '--control-checkbox-border-width',
      '--control-checkbox-bg',
      '--control-checkbox-border',
      '--control-checkbox-border-hover',
      '--control-checkbox-bg-checked',
      '--control-checkbox-border-checked',
      '--control-checkbox-mark',
      '--control-checkbox-shadow',
    ]))
  })
})
