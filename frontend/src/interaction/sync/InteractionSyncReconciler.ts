import type { InteractionMutation } from './InteractionSyncState'

type Identity = { id: number; nodeId?: number; clientKey?: string }

/** 服务端列表回写只替换 canonical 字段，已有前端身份由 id/nodeId/pending 认领。 */
export function reconcileCanvasItems<T extends Identity>(
  serverItems: T[], localItems: T[], pending: InteractionMutation[],
): T[] {
  const localById = new Map(localItems.map(item => [item.id, item]))
  const localByNodeId = new Map(localItems.filter(item => item.nodeId != null).map(item => [item.nodeId!, item]))
  const pendingByPersistedId = new Map(pending.filter(item => item.persistedItemId != null).map(item => [item.persistedItemId!, item]))
  const pendingByNodeId = new Map(pending.filter(item => item.nodeId != null).map(item => [item.nodeId!, item]))
  const claimed = new Set<string>()

  const result = serverItems.map(serverItem => {
    const mutation = pendingByPersistedId.get(serverItem.id)
      ?? (serverItem.nodeId == null ? undefined : pendingByNodeId.get(serverItem.nodeId))
    const local = localById.get(serverItem.id)
      ?? (serverItem.nodeId == null ? undefined : localByNodeId.get(serverItem.nodeId))
    const clientKey = local?.clientKey ?? mutation?.clientKey
    if (local) claimed.add(local.clientKey ?? `${local.id}`)
    return clientKey ? { ...serverItem, clientKey } : serverItem
  })

  // 请求尚未返回时保留 optimistic placeholder；已取消的 mutation 不得重新认领。
  for (const local of localItems) {
    const key = local.clientKey ?? `${local.id}`
    if (claimed.has(key) || !local.clientKey) continue
    const mutation = pending.find(item => item.clientKey === local.clientKey)
    if (mutation && !mutation.cancelled) result.push(local)
  }
  return result
}
