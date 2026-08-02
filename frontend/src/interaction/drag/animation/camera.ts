export interface LandingCameraOptions {
  revealEl: HTMLElement
  camGlue: HTMLElement
  origin: { left: number; top: number; width: number; height: number }
  isActive: () => boolean
}

/** 跟随画布相机的视觉壳；只同步位移/缩放，不修改落地动画本身。 */
export function trackLandingCamera(options: LandingCameraOptions): () => void {
  let cancelled = false
  let raf = 0
  let lastRectKey = ''
  const track = () => {
    if (cancelled || !options.isActive()) return
    const rect = options.revealEl.getBoundingClientRect()
    if (!options.revealEl.isConnected || rect.width < 1 || rect.height < 1) {
      raf = requestAnimationFrame(track)
      return
    }
    const rectKey = `${rect.left.toFixed(2)}|${rect.top.toFixed(2)}|${rect.width.toFixed(2)}`
    if (rectKey !== lastRectKey) {
      lastRectKey = rectKey
      const scaleRatio = options.origin.width > 0.01 ? rect.width / options.origin.width : 1
      options.camGlue.style.transform =
        `translate3d(${(rect.left - options.origin.left).toFixed(2)}px, ${(rect.top - options.origin.top).toFixed(2)}px, 0) scale(${scaleRatio.toFixed(4)})`
    }
    raf = requestAnimationFrame(track)
  }
  raf = requestAnimationFrame(track)
  return () => {
    cancelled = true
    cancelAnimationFrame(raf)
  }
}
