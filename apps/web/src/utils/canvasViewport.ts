/**
 * 无限画布的窗口化几何：相机坐标是屏幕坐标，贴纸坐标是世界坐标。
 * 缓冲区以屏幕像素定义，缩放后换算回世界坐标，保证边缘贴纸在任何倍率下都有同样的预渲染距离。
 */
export interface CanvasViewport {
  x: number
  y: number
  scale: number
  width: number
  height: number
}

export interface WorldRect {
  left: number
  top: number
  right: number
  bottom: number
}

export function worldViewport(viewport: CanvasViewport, bufferPx: number): WorldRect {
  const scale = viewport.scale || 1
  const buffer = bufferPx / scale
  return {
    left: -viewport.x / scale - buffer,
    top: -viewport.y / scale - buffer,
    right: (viewport.width - viewport.x) / scale + buffer,
    bottom: (viewport.height - viewport.y) / scale + buffer,
  }
}

export function overlapsWorldRect(item: { x: number; y: number; w: number; h: number }, viewport: WorldRect): boolean {
  return item.x + item.w >= viewport.left
    && item.x <= viewport.right
    && item.y + item.h >= viewport.top
    && item.y <= viewport.bottom
}
