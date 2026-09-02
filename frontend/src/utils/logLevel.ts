export type LogLevel = 'error' | 'warning' | 'info' | ''

/** 只读取日志行中的独立级别字段，避免 error_type 等业务字段误触发错误颜色。 */
export function classifyLogLevel(line: string): LogLevel {
  const match = line.match(/(?:^|[\s:[\]])(CRITICAL|ERROR|WARNING|WARN|INFO|DEBUG)(?=\s|$)/i)
  const level = match?.[1]?.toUpperCase()
  if (level === 'CRITICAL' || level === 'ERROR') return 'error'
  if (level === 'WARNING' || level === 'WARN') return 'warning'
  if (level === 'INFO') return 'info'
  return ''
}
