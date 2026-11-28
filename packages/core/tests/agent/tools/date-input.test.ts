import { describe, expect, it } from 'vitest'
import { dateInputNeedsYear, normalizeDateInput } from '../../../src/agent/tools/date-input.js'

// Python 对照：backend/app/core/date_input.py；明确注入年份，避免测试绑定本机时钟。
const cases: [string, string][] = [
  ['08-23', '2026-08-23'], ['08/23', '2026-08-23'], ['8.23', '2026-08-23'],
  ['2026-08-23', '2026-08-23'], ['2026/08/23', '2026-08-23'], ['08-23-2026', '2026-08-23'],
  ['26-08-23', '2026-08-23'], ['08-23-26', '2026-08-23'], ['2026年8月23日', '2026-08-23'], ['8月23日', '2026-08-23'],
  ['26年8月23', '2026-08-23'], ['00年1月2日', '2000-01-02'], ['1年1月1日', '0001-01-01'],
  ['0001-01-01', '2001-01-01'], ['9999-12-31', '9999-12-31'], ['01-02-03', '2003-01-02'],
  ['2000-2-29', '2000-02-29'], ['2024-2-29', '2024-02-29'], ['1900-2-28', '1900-02-28'],
  ['\u001c 2026 / 8 / 23 \u0085', '2026-08-23'], ['２０２６年８月２３日', '2026-08-23'], ['٢٠٢٦-٠٨-٢٣', '2026-08-23'],
]
describe('有限日期归一与Python格式对照', () => {
  it('Python16未定义的新数字不能被Node新版Unicode猜成年月日', () => {
    const newer = (value: string) => value.replace(/[0-9]/g, digit => String.fromCodePoint(0x11de0 + Number(digit)))
    for (const input of [newer('2026年8月23日'), newer('2026-08-23'), newer('8月23日'), newer('08/23')]) {
      expect(normalizeDateInput(input, 2026)).toBeNull()
      expect(dateInputNeedsYear(input)).toBe(false)
    }
  })
  it.each(cases)('%s → %s', (input, expected) => { expect(normalizeDateInput(input, 2026)).toBe(expected) })
  it.each(['', ' ', '2026-02-29', '1900-2-29', '2026-4-31', '2026-13-1', '2026-0-1', '2026-1-0', '0000年1月1日', '10000年1月1日', '2026-08-23T12:00:00Z', '明天', '1-1-1', '\ufeff2026-08-23'])('非法或未声明格式%s不猜测', input => {
    expect(normalizeDateInput(input, 2026)).toBeNull()
  })
  it('缺年份必须来自可信注入，完整年份不依赖默认年', () => {
    expect(normalizeDateInput('8月23日')).toBeNull()
    expect(normalizeDateInput('08/23')).toBeNull()
    expect(normalizeDateInput('2026-08-23')).toBe('2026-08-23')
    for (const invalid of [0, -1, 10000, NaN, Infinity, 2026.5]) expect(normalizeDateInput('8月23日', invalid)).toBeNull()
    expect(normalizeDateInput('2月29日', 2024)).toBe('2024-02-29')
    expect(normalizeDateInput('2月29日', 2026)).toBeNull()
  })
  it('保留Python低年份数值格式的MDY优先歧义，不擅自改变基准', () => {
    expect(normalizeDateInput('1年1月1日')).toBe('0001-01-01')
    expect(normalizeDateInput('0001-01-01')).toBe('2001-01-01')
  })
  it('常用年份规范结果再次归一幂等且不受默认年变化影响', () => {
    for (const [input, expected] of cases.filter(([, date]) => Number(date.slice(0, 4)) > 31)) expect(normalizeDateInput(normalizeDateInput(input, 2026)!, 2030)).toBe(expected)
  })
})
