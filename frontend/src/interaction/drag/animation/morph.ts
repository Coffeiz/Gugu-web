export interface MorphBox {
  left: number
  top: number
  width: number
  height: number
}

export interface MorphSize {
  w: number
  h: number
}

/** 计算双克隆从当前视觉尺寸到落点尺寸的同构 transform。 */
export function morphTransform(box: MorphBox, dropSize: MorphSize, half: { x: number; y: number }): string {
  const scaleX = (box.width / dropSize.w).toFixed(4)
  const scaleY = (box.height / dropSize.h).toFixed(4)
  const centerX = box.left + box.width / 2
  const centerY = box.top + box.height / 2
  return `translate3d(${(centerX - half.x).toFixed(2)}px, ${(centerY - half.y).toFixed(2)}px, 0) scale(${scaleX}, ${scaleY})`
}
