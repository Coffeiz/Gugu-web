import { describe, expect, it } from 'vitest'
import { formatFileCreatedDate } from './fileDate'

describe('文件创建日期展示', () => {
  it('将 UTC 时间戳按指定时区转换成本地日期', () => {
    expect(formatFileCreatedDate('2026-09-20T21:20:00Z', 'Asia/Shanghai')).toBe('2026-09-21')
  })

  it('兼容旧缓存中的纯日期值，不再做时区偏移', () => {
    expect(formatFileCreatedDate('2026-09-20', 'Asia/Shanghai')).toBe('2026-09-20')
  })
})
