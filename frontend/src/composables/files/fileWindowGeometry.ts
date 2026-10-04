export interface SelectionBox { left: number; top: number; width: number; height: number }
interface WindowGeometry {
  count: number; columns: number; stride: number; gap: number
  left: number; top: number; width: number
}

/** 命中完整目录的逻辑格子，不依赖卡片是否已经挂载。 */
export function fileWindowHitIndices(box: SelectionBox, layout: WindowGeometry): number[] {
  const cellWidth = (layout.width - layout.gap * (layout.columns - 1)) / layout.columns
  const firstRow = Math.max(0, Math.floor((box.top - layout.top) / layout.stride))
  const lastRow = Math.min(Math.ceil(layout.count / layout.columns) - 1, Math.floor((box.top + box.height - layout.top) / layout.stride))
  const indices: number[] = []
  for (let row = firstRow; row <= lastRow; row++) {
    const y = layout.top + row * layout.stride
    if (y >= box.top + box.height || y + layout.stride - layout.gap <= box.top) continue
    for (let col = 0; col < layout.columns; col++) {
      const x = layout.left + col * (cellWidth + layout.gap)
      const index = row * layout.columns + col
      if (index < layout.count && x < box.left + box.width && x + cellWidth > box.left) indices.push(index)
    }
  }
  return indices
}
