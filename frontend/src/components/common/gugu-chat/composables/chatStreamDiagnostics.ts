// 临时开发探针：仅存数字/布尔元数据，刷新后保留最近 300 条；不存正文或工具参数。
const key = 'gugu-chat-stream-diagnostics'
export function recordStreamDiagnostic(values: Record<string, number | boolean | null>, phase: string) {
  if (!import.meta.env.DEV) return
  try {
    const rows = JSON.parse(sessionStorage.getItem(key) || '[]')
    rows.push({ time: Date.now(), phase, ...values })
    sessionStorage.setItem(key, JSON.stringify(rows.slice(-300)))
  } catch {
    console.warn('聊天流诊断记录不可用')
  }
}
