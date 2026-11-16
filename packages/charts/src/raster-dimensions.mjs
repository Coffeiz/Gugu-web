const MAX_DIMENSION = 8_192
const MAX_PIXELS = 5_000_000
const TARGET_RASTER_SCALE = 2

function calculateRasterDimensions(width, height, targetScale) {
  if (
    !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
    width > MAX_DIMENSION || height > MAX_DIMENSION
  ) {
    throw new Error('pixel_limit_exceeded')
  }

  const rasterScale = Math.min(
    targetScale,
    MAX_DIMENSION / width,
    MAX_DIMENSION / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  )
  const rasterWidth = Math.max(1, Math.floor(width * rasterScale))
  const rasterHeight = Math.max(1, Math.floor(height * rasterScale))
  if (
    rasterWidth > MAX_DIMENSION || rasterHeight > MAX_DIMENSION ||
    rasterWidth * rasterHeight > MAX_PIXELS
  ) {
    throw new Error('pixel_limit_exceeded')
  }

  return { width: rasterWidth, height: rasterHeight }
}

/** 在边长与像素预算内计算 Mermaid SVG 的 2x PNG 输出尺寸。 */
export function calculateMermaidRasterDimensions(width, height) {
  return calculateRasterDimensions(width, height, TARGET_RASTER_SCALE)
}

/** 公式按 SVG 原始尺寸输出，避免相对 Mermaid 图片额外放大一倍。 */
export function calculateMathRasterDimensions(width, height) {
  return calculateRasterDimensions(width, height, 1)
}
