import { strip } from '../../shared/values.js'
import { asciiDecimalDigits, decimalDigitPattern } from '../../shared/unicode-decimal.js'

// Python re 的 \s 不含 BOM，包含四个分隔控制符；\d 对应 Unicode 十进制数字。
const whitespace = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*'
const digits = decimalDigitPattern
const yearMonthDay = new RegExp(`^(${digits}{1,4})${whitespace}年${whitespace}(${digits}{1,2})${whitespace}月${whitespace}(${digits}{1,2})${whitespace}日?$`, 'u')
const monthDay = new RegExp(`^(${digits}{1,2})${whitespace}月${whitespace}(${digits}{1,2})${whitespace}日?$`, 'u')
const monthDayParts = new RegExp(`^(${digits}{1,2})${whitespace}[-/.]${whitespace}(${digits}{1,2})$`, 'u')
const dateParts = new RegExp(`^(${digits}{1,4})${whitespace}[-/.]${whitespace}(${digits}{1,2})${whitespace}[-/.]${whitespace}(${digits}{1,4})$`, 'u')
/** 仅无年份的既有格式需要访问 Host 年份；完整非法日期不依赖该服务。 */
export function dateInputNeedsYear(value: string): boolean {
  const text = strip(value)
  return monthDay.test(text) || monthDayParts.test(text)
}
function integer(token: string): number { return Number(asciiDecimalDigits(token)) }
function year(token: string): number { return integer(token) + ([...token].length === 2 ? 2000 : 0) }
function canonical(year: number | undefined, month: number, day: number): string | null {
  if (year === undefined || !Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day > days[month - 1]!) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 对照 Python app/core/date_input.py 的有限格式，不处理时间或猜测业务日期。
 * 缺年份必须注入可信 defaultYear；不读取本机时钟。无效返回 null，保留原参数交给工具校验。
 */
export function normalizeDateInput(value: string, defaultYear?: number): string | null {
  if (typeof value !== 'string') return null
  const text = strip(value)
  if (!text) return null
  let match = yearMonthDay.exec(text)
  if (match) return canonical(year(match[1]!), integer(match[2]!), integer(match[3]!))
  match = monthDay.exec(text) ?? monthDayParts.exec(text)
  if (match) return canonical(defaultYear, integer(match[1]!), integer(match[2]!))
  match = dateParts.exec(text)
  if (!match) return null
  const first = match[1]!, second = match[2]!, third = match[3]!
  // 保持Python的MDY优先，包括0001-01-01被解释为2001-01-01的既有歧义。
  if ([2, 4].includes([...third].length) || integer(third) > 31) {
    const candidate = canonical(year(third), integer(first), integer(second))
    if (candidate !== null) return candidate
  }
  if ([2, 4].includes([...first].length) || integer(first) > 31) return canonical(year(first), integer(second), integer(third))
  return null
}
