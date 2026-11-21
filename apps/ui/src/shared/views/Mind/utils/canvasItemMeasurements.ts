import type { MindCanvasItem } from '@/services/api'

export interface CanvasItemSize {
  w: number
  h: number
}

/**
 * 乐观画布项换成服务端 node 后，clientKey 是唯一不变的尺寸缓存身份。
 * nodeId 缓存仍保留给关系层和可视窗口使用，避免把两套消费者绑在一起。
 */
export function cacheCanvasItemSize(
  byNodeId: Map<number, CanvasItemSize>,
  byClientKey: Map<string, CanvasItemSize>,
  item: Pick<MindCanvasItem, 'nodeId' | 'clientKey'>,
  size: CanvasItemSize,
) {
  byNodeId.set(item.nodeId, size)
  if (item.clientKey) byClientKey.set(item.clientKey, size)
}

/** 在乐观 nodeId 替换后，把稳定 clientKey 的尺寸交给新的 nodeId。 */
export function migrateCanvasItemSize(
  byNodeId: Map<number, CanvasItemSize>,
  byClientKey: Map<string, CanvasItemSize>,
  item: Pick<MindCanvasItem, 'nodeId' | 'clientKey'>,
) {
  if (!item.clientKey) return
  const size = byClientKey.get(item.clientKey)
  if (size) byNodeId.set(item.nodeId, size)
}

export function measuredCanvasItemSize(
  byNodeId: Map<number, CanvasItemSize>,
  byClientKey: Map<string, CanvasItemSize>,
  item: Pick<MindCanvasItem, 'nodeId' | 'clientKey'>,
) {
  return (item.clientKey ? byClientKey.get(item.clientKey) : undefined) ?? byNodeId.get(item.nodeId)
}
