/**
 * 将服务端确认结果与本地列表做幂等对账。
 *
 * 创建请求可能先收到实时事件，也可能先收到 HTTP 响应；两种顺序都只能保留
 * 一条服务端记录。字符串化比较是为了同时兼容数字 ID 和临时字符串 ID。
 */
export function upsertById<T extends { id: string | number }>(items: T[], item: T): T[] {
  return [item, ...items.filter(current => String(current.id) !== String(item.id))]
}

export function reconcileOptimisticById<T extends { id: string | number; _uid?: string }>(
  items: T[], optimisticUid: string, confirmed: T,
): T[] {
  const remaining = items.filter(item => item._uid === optimisticUid || String(item.id) !== String(confirmed.id))
  const index = remaining.findIndex(item => item._uid === optimisticUid)
  if (index >= 0) remaining[index] = confirmed
  else remaining.push(confirmed)
  return remaining
}
