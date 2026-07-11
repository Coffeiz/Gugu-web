import { describe, it, expect } from 'vitest'
import { fmtBytes } from './fileSize'

// 等价护栏：断言与 index.vue 抽出前逐字一致。
describe('fmtBytes', () => {
  it('0 / 假值 → 0 B', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(null)).toBe('0 B')
    expect(fmtBytes(undefined)).toBe('0 B')
  })
  it('B 档（<1024）原样拼接', () => {
    expect(fmtBytes(1)).toBe('1 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1023)).toBe('1023 B')
  })
  it('KB 取整（四舍五入）', () => {
    expect(fmtBytes(1024)).toBe('1 KB')
    expect(fmtBytes(1536)).toBe('2 KB')   // 1.5→toFixed(0) 进位
  })
  it('MB 保留 1 位', () => {
    expect(fmtBytes(1048576)).toBe('1.0 MB')
    expect(fmtBytes(1572864)).toBe('1.5 MB')
  })
  it('GB 保留 1 位', () => {
    expect(fmtBytes(1073741824)).toBe('1.0 GB')
    expect(fmtBytes(1610612736)).toBe('1.5 GB')
  })
})
