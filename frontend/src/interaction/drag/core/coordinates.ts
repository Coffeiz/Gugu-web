export interface ScreenSize {
  w: number
  h: number
}

export interface WorldSize {
  w: number
  h: number
}

/** 将屏幕尺寸转换为世界尺寸；通过两点相减抵消相机平移，只保留缩放影响。 */
export function screenSizeToWorld(
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number },
  size: ScreenSize,
): WorldSize {
  const origin = screenToWorld(0, 0)
  const corner = screenToWorld(size.w, size.h)
  return { w: corner.x - origin.x, h: corner.y - origin.y }
}
