/** 与 Python fmt_local 一致：数据库时间按 UTC 解释，再用可信用户时区输出分钟精度。 */
export function formatAgentHistoryMessageTime(timestamp: string | number, timezone: string): string {
  const dateInput = typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/u.test(timestamp)
    && !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/iu.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}Z` : timestamp
  const date = new Date(dateInput)
  if (!Number.isFinite(date.getTime())) throw new RangeError('历史消息时间无效')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`
}
