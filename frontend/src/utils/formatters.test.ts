import { beforeEach, describe, expect, it } from 'vitest'
import { formatFileSize, formatNumber, formatPercent, formatRelativeTime } from './formatters'
import { setLocale } from '@/i18n'

describe('locale-aware formatters', () => {
  beforeEach(() => setLocale('zh-CN'))

  it('uses the active locale for display', () => {
    setLocale('zh-CN')
    expect(formatRelativeTime('2026-08-30T11:59:30Z', new Date('2026-08-30T12:00:00Z'))).toBe('刚刚')
  })

  it('formats shared numeric values and file sizes', () => {
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatPercent(0.85)).toBe('85%')
    expect(formatFileSize(1024)).toBe('1 KB')
  })

  it('formats relative time without component-level unit concatenation', () => {
    const now = new Date('2026-08-30T12:00:00Z')
    expect(formatRelativeTime('2026-08-30T11:59:30Z', now)).toBe('刚刚')
    expect(formatRelativeTime('2026-08-30T11:00:00Z', now)).toBe('1小时前')
  })
})
