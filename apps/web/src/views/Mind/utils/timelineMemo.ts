type TimelineMemoItem = object & { id: number; version: number }

const itemIdentity = new WeakMap<object, number>()
let nextItemIdentity = 1

function identityOf(item: object): number {
  const existing = itemIdentity.get(item)
  if (existing !== undefined) return existing
  const identity = nextItemIdentity++
  itemIdentity.set(item, identity)
  return identity
}

/**
 * 时间流列只在本列便签集合/版本/对象实例或交互状态变化时更新。
 * 对象实例也纳入签名：乐观更新会替换 note 对象但暂不递增服务端 version，
 * 仅按 id/version memo 会错误跳过预览刷新，直到请求提交后才显示新内容。
 */
export function timelineColumnMemoKey(
  items: readonly TimelineMemoItem[],
  highlightId: number | null,
  editingId: number | null,
  conflict: boolean,
): string {
  const itemSignature = items
    .map(item => `${item.id}:${item.version}:${identityOf(item)}`)
    .join('|')
  const highlighted = items.some(item => item.id === highlightId) ? highlightId : ''
  const editing = items.some(item => item.id === editingId) ? editingId : ''
  return `${itemSignature};h:${highlighted};e:${editing};c:${editing ? conflict : ''}`
}
