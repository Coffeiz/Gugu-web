/**
 * 「点击弹层外部关闭」的拖选保护。
 *
 * 在弹层内的输入框/文字上按下并拖动选择、把选区拖出弹层后松开时，浏览器把
 * click 派发到释放点（mousedown 与 mouseup 目标的公共祖先），只看 click 的
 * target 会判定为「点了外面」而把弹层误关。
 *
 * 规则：按下（mousedown）与释放（click）都发生在弹层外部，才算一次真正的
 * 「点外关闭」。组件在自身的 mousedown 捕获监听里调 `notePress` 记录按下
 * 位置，再在 click 处理器里用 `shouldCloseOn` 判定（每次 click 消费一次
 * 按下记录，避免状态残留影响下一次判定）。
 */
export interface PressOutsideGuard {
  /** 在 document 的 mousedown（捕获）监听里调用，记录按下起点。 */
  notePress(e: MouseEvent): void
  /**
   * 在 click 处理器里调用。返回 true 表示这次点击算「点外」，可以关闭。
   * 无论提前 return 与否都应调用一次，以消费掉按下的记录。
   */
  shouldCloseOn(e: MouseEvent): boolean
}

export function createPressOutsideGuard(contains: (target: Node) => boolean): PressOutsideGuard {
  let pressInside = false
  let pressPending = false

  function isInside(target: EventTarget | null): boolean {
    return target instanceof Node && contains(target)
  }

  return {
    notePress(e: MouseEvent) {
      pressInside = isInside(e.target)
      pressPending = true
    },
    shouldCloseOn(e: MouseEvent): boolean {
      const releasedInside = isInside(e.target)
      const inside = pressPending ? pressInside || releasedInside : releasedInside
      pressPending = false
      return !inside
    },
  }
}

/** 组合多个容器判定（任一包含即算内部）。 */
export function containsAny(...contains: Array<(target: Node) => boolean | undefined | null>) {
  return (target: Node) => contains.some(fn => !!fn?.(target))
}
