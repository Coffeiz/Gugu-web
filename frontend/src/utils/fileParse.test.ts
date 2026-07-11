import { describe, it, expect } from 'vitest'
import { doneYear, doneMonth, splitName } from './fileParse'

describe('doneYear / doneMonth — 完成日期分桶', () => {
  it('优先 doneAt', () => {
    const p = { doneAt: '2026-07-11', startDate: '2025-01-01', createdAt: '2024-01-01' }
    expect(doneYear(p)).toBe('2026')
    expect(doneMonth(p)).toBe('07')
  })
  it('doneAt 缺则退 startDate，再退 createdAt', () => {
    expect(doneYear({ startDate: '2025-03-02' })).toBe('2025')
    expect(doneMonth({ createdAt: '2024-12-31' })).toBe('12')
  })
  it('全空 → 未归类 / 00', () => {
    expect(doneYear({})).toBe('未归类')
    expect(doneMonth({})).toBe('00')
    expect(doneYear({ doneAt: null })).toBe('未归类')
  })
})

describe('splitName — 文件名拆分', () => {
  it('普通名拆 base + ext（ext 不含点、不改大小写）', () => {
    expect(splitName('report.PDF')).toEqual({ base: 'report', ext: 'PDF' })
    expect(splitName('a.b.txt')).toEqual({ base: 'a.b', ext: 'txt' })
  })
  it('无扩展名 → ext 为空', () => {
    expect(splitName('README')).toEqual({ base: 'README', ext: '' })
  })
  it('以点结尾 → ext 空、base 含名', () => {
    expect(splitName('foo.')).toEqual({ base: 'foo', ext: '' })
  })
  it('隐藏文件（点开头）→ base 空、ext 为其余', () => {
    expect(splitName('.gitignore')).toEqual({ base: '', ext: 'gitignore' })
  })
})
