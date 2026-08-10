import { describe, expect, it } from 'vitest'
import { capBg, darkenHex, extractAccent, hexAlpha } from './calendarColors'

describe('calendarColors', () => {
  it('提取合法六位颜色并为非法值提供稳定默认色', () => {
    expect(extractAccent('linear-gradient(#123456, #ffffff)')).toBe('#123456')
    expect(extractAccent(undefined)).toBe('#7b7fb2')
  })

  it('生成颜色透明度、进度背景和加深色', () => {
    expect(hexAlpha('#123456', 0.3)).toBe('rgba(18,52,86,0.3)')
    expect(capBg('#123456', undefined)).toBe('rgba(18,52,86,0.1)')
    expect(capBg('#123456', 50)).toContain('50%')
    expect(darkenHex('#123456')).toBe('rgb(11,31,52)')
  })
})
