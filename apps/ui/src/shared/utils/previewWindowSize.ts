type PreviewSize = { width: number; height: number }
type PreviewSurface = 'floating' | 'drawer'

export function readPreviewWindowSize(surface: PreviewSurface): PreviewSize | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(`gugu-preview-size-${surface}`) ?? 'null')
    if (value && Number.isSafeInteger(value.width) && value.width > 0
      && Number.isSafeInteger(value.height) && value.height > 0)
      return { width: value.width, height: value.height }
  } catch { /* 偏好不可用时沿用默认尺寸。 */ }
}

export function savePreviewWindowSize(surface: PreviewSurface, { width, height }: PreviewSize) {
  try {
    window.localStorage.setItem(`gugu-preview-size-${surface}`, JSON.stringify({
      width: Math.round(width), height: Math.round(height),
    }))
  } catch { /* 本次调整仍可使用。 */ }
}
