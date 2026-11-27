/** 每个宿主选择稳定的游标，返回给客户端的消息一律按时间线正序。 */
export function projectAgentHistoryPage<Row, Cursor>(rows: readonly Row[],
  direction: 'asc' | 'desc', cursorOf: (row: Row) => Cursor) {
  const messages = direction === 'asc' ? [...rows] : [...rows].reverse()
  const first = messages[0]
  const last = messages.at(-1)
  return { messages, oldestId: first === undefined ? null : cursorOf(first),
    newestId: last === undefined ? null : cursorOf(last) }
}
